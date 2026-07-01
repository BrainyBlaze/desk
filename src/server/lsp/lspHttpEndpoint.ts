import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFsPath } from '../fsSafety.js';
import { readJsonBody, sendJson } from '../httpUtil.js';
import type { LspRequestApi } from './requestApi.js';
import type { LspCapabilityTokenRegistry } from './capabilityTokenRegistry.js';

export interface LspHttpEndpointDependencies {
  tokenRegistry: LspCapabilityTokenRegistry;
  requestApi: LspRequestApi;
}

export interface LspHttpEndpointRequest {
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  body: unknown;
  url?: string;
}

export interface LspHttpEndpointResponse {
  statusCode: number;
  body: unknown;
}

export interface LspHttpEndpoint {
  handleRequest(request: LspHttpEndpointRequest): Promise<LspHttpEndpointResponse>;
  handleNodeRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

const SENSITIVE_KEYS = new Set([
  'servercommands',
  'env',
  'command',
  'args',
  'initializationoptions',
  'token',
  'workspaceroot'
]);

export function createLspHttpEndpoint({ tokenRegistry, requestApi }: LspHttpEndpointDependencies): LspHttpEndpoint {
  async function handleRequest(request: LspHttpEndpointRequest): Promise<LspHttpEndpointResponse> {
    const token = extractBearerToken(request.headers);
    const binding = token ? tokenRegistry.resolve(token) : undefined;
    if (!token || !binding) {
      return errorResponse(401, 'unauthorized', 'Unauthorized LSP request');
    }

    const body = request.body;
    if (!isRecord(body)) {
      return errorResponse(400, 'invalid_request', 'Invalid LSP request');
    }

    const uriCheck = validateTextDocumentUri(body, binding.workspaceRoot);
    if (!uriCheck.ok) {
      return errorResponse(uriCheck.statusCode, uriCheck.code, uriCheck.message);
    }

    const sanitizedBody = { ...body, workspaceRoot: binding.workspaceRoot };
    let response: unknown;
    try {
      response = await requestApi.handleRequest(sanitizedBody);
    } catch {
      return errorResponse(500, 'internal_error', 'LSP request failed');
    }
    return {
      statusCode: 200,
      body: redactPayload(response, [token, binding.workspaceRoot], {
        preserveWorkspaceRootInLocationUris: isLocationMethod(body.method),
        codeAction: isCodeActionMethod(body.method),
        workspaceRoot: binding.workspaceRoot
      })
    };
  }

  return {
    handleRequest,

    async handleNodeRequest(req, res, url) {
      if (req.method !== 'POST' || url.pathname !== '/api/lsp') {
        return false;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, errorResponse(400, 'invalid_json', 'Invalid JSON body').body);
        return true;
      }
      const response = await handleRequest({ headers: req.headers, body, url: req.url });
      sendJson(res, response.statusCode, response.body);
      return true;
    }
  };
}

function extractBearerToken(headers: LspHttpEndpointRequest['headers']): string | undefined {
  const raw = headers.authorization ?? headers.Authorization;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(raw);
  return match?.[1];
}

function validateTextDocumentUri(
  body: Record<string, unknown>,
  workspaceRoot: string
):
  | { ok: true }
  | { ok: false; statusCode: number; code: 'invalid_request' | 'forbidden'; message: string } {
  const params = body.params;
  if (!isRecord(params) || !isRecord(params.textDocument) || typeof params.textDocument.uri !== 'string') {
    return invalidLspRequest();
  }

  let uri: URL;
  try {
    uri = new URL(params.textDocument.uri);
  } catch {
    return invalidLspRequest();
  }

  if (uri.protocol !== 'file:') {
    return invalidLspRequest();
  }

  let filePath: string;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    return invalidLspRequest();
  }

  try {
    const resolved = resolveFsPath(filePath, workspaceRoot);
    const rel = relative(workspaceRoot, resolved);
    if (rel.split(sep).includes('..')) {
      return forbiddenLspRequest();
    }
  } catch {
    return forbiddenLspRequest();
  }

  return { ok: true };
}

function invalidLspRequest() {
  return {
    ok: false as const,
    statusCode: 400,
    code: 'invalid_request' as const,
    message: 'Invalid LSP request'
  };
}

function forbiddenLspRequest() {
  return {
    ok: false as const,
    statusCode: 403,
    code: 'forbidden' as const,
    message: 'LSP request is outside the authorized workspace'
  };
}

function errorResponse(statusCode: number, code: string, message: string): LspHttpEndpointResponse {
  return {
    statusCode,
    body: {
      ok: false,
      error: { code, message }
    }
  };
}

interface RedactionOptions {
  preserveWorkspaceRootInLocationUris?: boolean;
  workspaceRoot?: string;
  codeAction?: boolean;
}

function redactPayload(value: unknown, secrets: readonly string[], options: RedactionOptions = {}, key?: string): unknown {
  if (typeof value === 'string') {
    const preserveRoot =
      (options.preserveWorkspaceRootInLocationUris && isLocationUriKey(key)) ||
      (options.codeAction === true && isCodeActionUriKey(key));
    const activeSecrets = preserveRoot ? secrets.filter((secret) => secret !== options.workspaceRoot) : secrets;
    return activeSecrets.reduce((next, secret) => (secret ? next.split(secret).join('[redacted]') : next), value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPayload(entry, secrets, options, key));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([entryKey]) => !SENSITIVE_KEYS.has(entryKey.toLowerCase()))
        .filter(([entryKey]) => !(options.codeAction === true && CODE_ACTION_STRIP_KEYS.has(entryKey)))
        .map(([entryKey, entry]) => [
          options.codeAction === true ? redactCodeActionKey(entryKey, secrets, options) : entryKey,
          redactPayload(entry, secrets, options, entryKey)
        ])
    );
  }
  return value;
}

// WorkspaceEdit changes maps are keyed by document URIs that legitimately embed the workspace
// root; preserve the root in the key but scrub every other secret (e.g. the capability token).
function redactCodeActionKey(key: string, secrets: readonly string[], options: RedactionOptions): string {
  const activeSecrets = secrets.filter((secret) => secret !== options.workspaceRoot);
  return activeSecrets.reduce((next, secret) => (secret ? next.split(secret).join('[redacted]') : next), key);
}

const CODE_ACTION_STRIP_KEYS = new Set(['command', 'arguments', 'data']);

function isCodeActionMethod(method: unknown): boolean {
  return method === 'textDocument/codeAction';
}

function isCodeActionUriKey(key: string | undefined): boolean {
  return key === 'uri' || key === 'targetUri' || key === 'oldUri' || key === 'newUri';
}

function isLocationMethod(method: unknown): boolean {
  return (
    method === 'textDocument/definition' ||
	    method === 'textDocument/references' ||
	    method === 'textDocument/typeDefinition' ||
	    method === 'textDocument/implementation' ||
	    method === 'textDocument/declaration'
	  );
	}

function isLocationUriKey(key: string | undefined): boolean {
  return key === 'uri' || key === 'targetUri';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
