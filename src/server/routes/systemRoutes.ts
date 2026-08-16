import { homedir } from 'node:os';
import {
  observationEnvelope,
  type AgentObservationScope
} from '../../core/agentState/providerAdapter.js';
import {
  adaptAgentEndpointRegistration,
  agentEndpointFingerprint,
  parseAgentEndpointActivation,
  parseDeskEventClearResponse,
  parseDeskEventFeedResponse,
  parseDeskEventReadRequest,
  parseDeskEventReadResponse,
  parseSessionStateSnapshot,
  type AgentEndpointRegistration,
  type AgentStateEnvelope,
  type DeskEventReadRequest,
  type SessionStateSnapshot
} from '../../shared/controlPlane/index.js';
import {
  completeProviderSessionLaunch as completeProviderSessionLaunchDefault,
  daemonControl,
  daemonControlGet,
  observeProviderSessionIdentity as observeProviderSessionIdentityDefault,
  type CompleteProviderSessionLaunchRequest,
  type DaemonControlOptions,
  type DaemonControlResult
} from '../../shared/daemonControlClient.js';
import { readJsonBody, sendJson } from '../httpUtil.js';
import {
  confirmClaudeSessionStart as confirmClaudeSessionStartDefault,
  type ConfirmClaudeSessionStartResult
} from '../claudeProfileContinuity.js';
import {
  bindProviderSessionIdentity as bindProviderSessionIdentityDefault,
  type BindProviderSessionIdentityInput,
  type ProviderSessionBindingResult
} from '../providerSessionBinding.js';
import { executeKillSwitch } from '../killSwitch.js';
import type { DeskRoute } from '../plugin.js';
import { buildDeskSnapshot } from '../snapshot.js';
import { getSystemSnapshot } from '../systemSampler.js';
import {
  isValidProviderSessionId,
  type ProviderSessionProvider
} from '../../shared/providerSessionIdentity.js';

interface ManagedAgentLifecycle {
  reconcile(runningSessions: Set<string>): void;
  cleanupAll(): void;
}

export interface AgentStateGateway {
  submitEvent(
    envelope: AgentStateEnvelope,
    scope?: AgentObservationScope
  ): Promise<DaemonControlResult>;
  readStates(): Promise<DaemonControlResult>;
}

export interface AgentEndpointGateway {
  registerEndpoint(registration: AgentEndpointRegistration): Promise<DaemonControlResult>;
  activateEndpoint(
    activation: ReturnType<typeof parseAgentEndpointActivation>
  ): Promise<DaemonControlResult>;
}

export interface DeskEventGateway {
  readEvents(limit: number): Promise<DaemonControlResult>;
  markEventsRead(input: DeskEventReadRequest): Promise<DaemonControlResult>;
  clearEvents(): Promise<DaemonControlResult>;
}

export interface SystemRoutesOptions {
  agentStateGateway?: AgentStateGateway;
  agentEndpointGateway?: AgentEndpointGateway;
  deskEventGateway?: DeskEventGateway;
  confirmClaudeSessionStart?: (
    input: ClaudeSessionStartIdentity
  ) => ConfirmClaudeSessionStartResult;
  /** OpenCode endpoint activation retains its staged binder path. */
  bindProviderSessionIdentity?: (
    input: BindProviderSessionIdentityInput
  ) => Promise<ProviderSessionBindingResult>;
  /** OpenCode endpoint activation completes its launch after durable binding. */
  completeProviderSessionLaunch?: (
    input: CompleteProviderSessionLaunchRequest
  ) => Promise<DaemonControlResult>;
  observeProviderSessionIdentity?: (
    input: ProviderSessionObservationRequest,
    options?: DaemonControlOptions
  ) => Promise<DaemonControlResult>;
  now?: () => number;
  providerSessionRetryNow?: () => number;
  providerSessionRetrySleep?: (
    milliseconds: number,
    signal: AbortSignal
  ) => Promise<void>;
}

export interface ClaudeSessionStartIdentity {
  deskSessionId: string;
  providerSessionId: string;
}

interface ProviderHookIdentity {
  deskSessionId: string;
  generation: number;
  provider: Exclude<ProviderSessionProvider, 'opencode'>;
  providerSessionId: string;
  hook: string;
  isSessionStart: boolean;
  launchProof: string;
}

interface ProviderSessionObservationRequest {
  deskSessionId: string;
  generation: number;
  provider: Exclude<ProviderSessionProvider, 'opencode'>;
  providerSessionId: string;
  hook: string;
  launchProof: string;
}

interface AgentStateView {
  revision: number;
  snapshots: SessionStateSnapshot[];
}

type AgentStateRead =
  | { ok: true; view: AgentStateView }
  | { ok: false; status: number; body: Record<string, unknown> };

const defaultAgentStateGateway: AgentStateGateway = {
  submitEvent: (envelope, scope) =>
    daemonControl(
      '/control/agent-event',
      scope === undefined ? envelope : { envelope, scope }
    ),
  readStates: () => daemonControlGet('/control/agent-states')
};

const defaultAgentEndpointGateway: AgentEndpointGateway = {
  registerEndpoint: (registration) =>
    daemonControl('/control/agent-endpoint', registration),
  activateEndpoint: (activation) =>
    daemonControl('/control/agent-endpoint/activate', activation)
};

const defaultDeskEventGateway: DeskEventGateway = {
  readEvents: (limit) =>
    daemonControlGet(`/control/events?limit=${encodeURIComponent(limit)}`),
  markEventsRead: (input) => daemonControl('/control/events/read', input),
  clearEvents: () => daemonControl('/control/events/clear', {})
};

function providerHookIdentity(
  input: unknown
):
  | { kind: 'none' }
  | {
      kind: 'invalid';
      code:
        | 'provider-session-id-missing'
        | 'provider-session-id-invalid'
        | 'provider-session-proof-missing';
      error: string;
    }
  | { kind: 'identity'; value: ProviderHookIdentity } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { kind: 'none' };
  }
  const body = input as Record<string, unknown>;
  let provider: ProviderHookIdentity['provider'];
  if (body.provider === 'claude' && body.producer === 'claude-hooks') {
    provider = 'claude';
  } else if (body.provider === 'codex' && body.producer === 'codex-hooks') {
    provider = 'codex';
  } else {
    return { kind: 'none' };
  }
  const observation = body.observation;
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return { kind: 'none' };
  }
  const fields = observation as Record<string, unknown>;
  if (
    typeof fields.providerSessionId !== 'string' ||
    fields.providerSessionId.trim().length === 0
  ) {
    return {
      kind: 'invalid',
      code: 'provider-session-id-missing',
      error: `${provider} hook did not include a provider session id`
    };
  }
  const providerSessionId = fields.providerSessionId.trim();
  if (!isValidProviderSessionId(provider, providerSessionId)) {
    return {
      kind: 'invalid',
      code: 'provider-session-id-invalid',
      error: `Invalid ${provider} provider session id`
    };
  }
  if (
    typeof body.launchProof !== 'string' ||
    body.launchProof.trim().length === 0
  ) {
    return {
      kind: 'invalid',
      code: 'provider-session-proof-missing',
      error: `${provider} hook did not include a provider launch proof`
    };
  }
  return {
    kind: 'identity',
    value: {
      deskSessionId: body.sessionId as string,
      generation: body.generation as number,
      provider,
      providerSessionId,
      hook: fields.hook as string,
      isSessionStart: fields.hook === 'SessionStart',
      launchProof: body.launchProof
    }
  };
}

function gatewayFailure(result: DaemonControlResult): Extract<AgentStateRead, { ok: false }> {
  const status =
    result.status !== undefined && result.status >= 400 && result.status <= 599
      ? result.status
      : 503;
  return {
    ok: false,
    status,
    body:
      result.body ??
      {
        ok: false,
        error: result.error ?? 'terminal daemon unavailable'
      }
  };
}

async function readAgentStateView(gateway: AgentStateGateway): Promise<AgentStateRead> {
  let result: DaemonControlResult;
  try {
    result = await gateway.readStates();
  } catch (error) {
    return {
      ok: false,
      status: 503,
      body: {
        ok: false,
        error: `terminal daemon unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
  if (!result.ok) {
    return gatewayFailure(result);
  }

  const revision = result.body?.revision;
  const rawSnapshots = result.body?.snapshots;
  if (
    result.body?.ok !== true ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Array.isArray(rawSnapshots)
  ) {
    return {
      ok: false,
      status: 502,
      body: { ok: false, error: 'terminal daemon returned malformed agent state' }
    };
  }

  try {
    const snapshots = rawSnapshots.map(parseSessionStateSnapshot);
    const sessionIds = new Set<string>();
    for (const snapshot of snapshots) {
      if (snapshot.revision > revision || sessionIds.has(snapshot.sessionId)) {
        throw new Error('inconsistent agent-state revision');
      }
      sessionIds.add(snapshot.sessionId);
    }
    return { ok: true, view: { revision, snapshots } };
  } catch {
    return {
      ok: false,
      status: 502,
      body: { ok: false, error: 'terminal daemon returned malformed agent state' }
    };
  }
}

const PROVIDER_EVIDENCE_RETRY_OFFSETS_MS = [0, 200, 400, 600, 800] as const;
const PROVIDER_EVIDENCE_RETRY_DEADLINE_MS = 1_000;

function sleepForProviderEvidence(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function providerObservationCall(
  gateway: NonNullable<SystemRoutesOptions['observeProviderSessionIdentity']>,
  input: ProviderSessionObservationRequest,
  options: DaemonControlOptions,
  signal: AbortSignal
): Promise<DaemonControlResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DaemonControlResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void =>
      finish({
        ok: false,
        error: 'provider session observation deadline exceeded'
      });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void gateway(input, options).then(finish, (error: unknown) =>
      finish({
        ok: false,
        error: `terminal daemon unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
    );
  });
}

async function observeProviderIdentityWithRetry(input: {
  identity: ProviderHookIdentity;
  gateway: NonNullable<SystemRoutesOptions['observeProviderSessionIdentity']>;
  now: () => number;
  sleep: NonNullable<SystemRoutesOptions['providerSessionRetrySleep']>;
  callerSignal: AbortSignal;
}): Promise<DaemonControlResult> {
  const startedAt = input.now();
  const deadlineController = new AbortController();
  const timer = setTimeout(
    () => deadlineController.abort('provider observation deadline'),
    PROVIDER_EVIDENCE_RETRY_DEADLINE_MS
  );
  timer.unref?.();
  const signal = AbortSignal.any([
    input.callerSignal,
    deadlineController.signal
  ]);
  let result: DaemonControlResult = {
    ok: false,
    error: 'provider session observation deadline exceeded'
  };
  try {
    for (const offset of PROVIDER_EVIDENCE_RETRY_OFFSETS_MS) {
      const delay = startedAt + offset - input.now();
      if (delay > 0) await input.sleep(delay, signal);
      const remaining = Math.ceil(
        startedAt + PROVIDER_EVIDENCE_RETRY_DEADLINE_MS - input.now()
      );
      if (remaining <= 0 || signal.aborted) return result;
      result = await providerObservationCall(
        input.gateway,
        {
          deskSessionId: input.identity.deskSessionId,
          provider: input.identity.provider,
          providerSessionId: input.identity.providerSessionId,
          generation: input.identity.generation,
          launchProof: input.identity.launchProof,
          hook: input.identity.hook
        },
        { timeoutMs: remaining, signal },
        signal
      );
      if (
        !input.identity.isSessionStart ||
        result.body?.reason !== 'provider-session-evidence-missing'
      ) {
        return result;
      }
    }
    return result;
  } catch {
    return {
      ok: false,
      error: signal.aborted
        ? 'provider session observation deadline exceeded'
        : 'provider session evidence retry failed'
    };
  } finally {
    clearTimeout(timer);
  }
}

function providerObservationFailure(
  result: DaemonControlResult
): { status: number; body: Record<string, unknown> } {
  const response = result.body;
  const scrub = (value: string): string =>
    value.replace(
      /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{43})(?=$|[^A-Za-z0-9_-])/g,
      '$1[redacted]'
    );
  const reason =
    typeof response?.reason === 'string'
      ? response.reason
      : 'provider-session-observation-failed';
  const error = scrub(
    typeof response?.error === 'string'
      ? response.error
      : result.error ?? 'terminal daemon unavailable'
  );
  const status =
    result.status !== undefined && result.status >= 400 && result.status <= 599
      ? result.status
      : 503;
  const safe: Record<string, unknown> = { ok: false, reason, error };
  for (const key of [
    'currentProviderSessionId',
    'targetProviderSessionId',
    'action'
  ] as const) {
    const value = response?.[key];
    if (typeof value === 'string') safe[key] = scrub(value);
  }
  return { status, body: safe };
}

export function createSystemRoutes(
  managedAgentLsp: ManagedAgentLifecycle,
  options: SystemRoutesOptions = {}
): DeskRoute {
  const agentStateGateway = options.agentStateGateway ?? defaultAgentStateGateway;
  const agentEndpointGateway =
    options.agentEndpointGateway ?? defaultAgentEndpointGateway;
  const deskEventGateway = options.deskEventGateway ?? defaultDeskEventGateway;
  const confirmClaudeSessionStart =
    options.confirmClaudeSessionStart ??
    ((input: ClaudeSessionStartIdentity) =>
      confirmClaudeSessionStartDefault({
        homeDir: homedir(),
        ...input
      }));
  const observeProviderSessionIdentity =
    options.observeProviderSessionIdentity ??
    observeProviderSessionIdentityDefault;
  const bindProviderSessionIdentity =
    options.bindProviderSessionIdentity ?? bindProviderSessionIdentityDefault;
  const completeProviderSessionLaunch =
    options.completeProviderSessionLaunch ??
    completeProviderSessionLaunchDefault;
  const providerSessionRetryNow =
    options.providerSessionRetryNow ?? (() => performance.now());
  const providerSessionRetrySleep =
    options.providerSessionRetrySleep ?? sleepForProviderEvidence;
  const now = options.now ?? Date.now;
  return async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/desk') {
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/system') {
      sendJson(res, 200, getSystemSnapshot());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/pulse') {
      const stateRead = await readAgentStateView(agentStateGateway);
      if (!stateRead.ok) {
        sendJson(res, 200, { system: getSystemSnapshot() });
        return true;
      }
      const runningIds = new Set(
        stateRead.view.snapshots
          .filter((snapshot) => snapshot.lifecycle === 'running')
          .map((snapshot) => snapshot.sessionId)
      );
      managedAgentLsp.reconcile(runningIds);
      sendJson(res, 200, {
        system: getSystemSnapshot(),
        agentStates: stateRead.view,
        running: [...runningIds]
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/agent-states') {
      const stateRead = await readAgentStateView(agentStateGateway);
      if (!stateRead.ok) {
        sendJson(res, stateRead.status, stateRead.body);
        return true;
      }
      sendJson(res, 200, { ok: true, ...stateRead.view });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent-event') {
      const body = await readJsonBody(req);
      const { launchProof: _launchProof, ...boundedBody } = body;
      const adapted = observationEnvelope(boundedBody, { observedAt: now() });
      if (adapted.kind === 'invalid') {
        sendJson(res, 400, {
          ok: false,
          error: 'invalid agent-state observation',
          reason: adapted.reason
        });
        return true;
      }
      const providerIdentity = providerHookIdentity(body);
      if (providerIdentity.kind === 'invalid') {
        sendJson(res, 409, {
          ok: false,
          code: providerIdentity.code,
          error: providerIdentity.error
        });
        return true;
      }
      if (providerIdentity.kind === 'identity') {
        const identity = providerIdentity.value;
        if (identity.provider === 'claude' && identity.isSessionStart) {
          let confirmation: ConfirmClaudeSessionStartResult;
          try {
            confirmation = confirmClaudeSessionStart({
              deskSessionId: identity.deskSessionId,
              providerSessionId: identity.providerSessionId
            });
          } catch (error) {
            confirmation = {
              ok: false,
              code: 'continuity-store-corrupt',
              error: error instanceof Error ? error.message : String(error)
            };
          }
          if (!confirmation.ok) {
            sendJson(res, 409, confirmation);
            return true;
          }
        }

        const callerController = new AbortController();
        req.once('aborted', () => callerController.abort('request aborted'));
        if (typeof res.once === 'function') {
          res.once('close', () => {
            if (!res.writableEnded) {
              callerController.abort('response closed');
            }
          });
        }
        const observed = await observeProviderIdentityWithRetry({
          identity,
          gateway: observeProviderSessionIdentity,
          now: providerSessionRetryNow,
          sleep: providerSessionRetrySleep,
          callerSignal: callerController.signal
        });
        if (!observed.ok) {
          const failure = providerObservationFailure(observed);
          sendJson(res, failure.status, failure.body);
          return true;
        }
        if (
          observed.body?.ok !== true ||
          (observed.body.kind !== 'bound' &&
            observed.body.kind !== 'matching')
        ) {
          sendJson(res, 502, {
            ok: false,
            error:
              'terminal daemon returned malformed provider session observation receipt'
          });
          return true;
        }
      }
      if (adapted.kind === 'no-facts') {
        sendJson(res, 200, { ok: true, kind: 'no-facts' });
        return true;
      }
      const envelope: AgentStateEnvelope = adapted.envelope;

      let result: DaemonControlResult;
      try {
        result =
          adapted.scope === undefined
            ? await agentStateGateway.submitEvent(envelope)
            : await agentStateGateway.submitEvent(envelope, adapted.scope);
      } catch (error) {
        result = {
          ok: false,
          error: `terminal daemon unavailable: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      if (!result.ok) {
        const failure = gatewayFailure(result);
        sendJson(res, failure.status, failure.body);
        return true;
      }
      if (result.body?.ok !== true) {
        sendJson(res, 502, { ok: false, error: 'terminal daemon returned malformed agent-event receipt' });
        return true;
      }
      sendJson(res, result.status ?? 200, result.body);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent-endpoint') {
      const body = await readJsonBody(req);
      const adapted = adaptAgentEndpointRegistration(body, { observedAt: now() });
      if (adapted.kind === 'invalid') {
        sendJson(res, 400, {
          ok: false,
          error: 'invalid agent endpoint registration',
          reason: adapted.reason
        });
        return true;
      }

      let result: DaemonControlResult;
      try {
        result = await agentEndpointGateway.registerEndpoint(adapted.registration);
      } catch (error) {
        result = {
          ok: false,
          error: `terminal daemon unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
      if (!result.ok) {
        const failure = gatewayFailure(result);
        sendJson(res, failure.status, failure.body);
        return true;
      }
      if (
        result.body?.ok !== true ||
        (result.body.kind !== 'accepted' && result.body.kind !== 'duplicate') ||
        typeof result.body.active !== 'boolean'
      ) {
        sendJson(res, 502, {
          ok: false,
          error: 'terminal daemon returned malformed agent endpoint receipt'
        });
        return true;
      }
      const providerSessionId = adapted.registration.providerSessionId;
      if (providerSessionId === undefined) {
        sendJson(res, result.status ?? 200, result.body);
        return true;
      }

      let binding: ProviderSessionBindingResult;
      try {
        binding = await bindProviderSessionIdentity({
          deskSessionId: adapted.registration.sessionId,
          provider: 'opencode',
          providerSessionId
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          code: 'provider-session-store-failed',
          error: `provider session identity storage failed: ${error instanceof Error ? error.message : String(error)}`
        });
        return true;
      }
      if (!binding.ok) {
        sendJson(res, 409, binding);
        return true;
      }

      let completion: DaemonControlResult;
      try {
        completion = await completeProviderSessionLaunch({
          deskSessionId: adapted.registration.sessionId,
          provider: 'opencode',
          providerSessionId,
          generation: adapted.registration.generation
        });
      } catch (error) {
        completion = {
          ok: false,
          error: `terminal daemon unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
      if (!completion.ok) {
        const failure = gatewayFailure(completion);
        sendJson(res, failure.status, failure.body);
        return true;
      }
      if (
        completion.body?.ok !== true ||
        (completion.body.kind !== 'completed' &&
          completion.body.kind !== 'not-required')
      ) {
        sendJson(res, 502, {
          ok: false,
          error:
            'terminal daemon returned malformed provider launch completion receipt'
        });
        return true;
      }

      const activation = parseAgentEndpointActivation(
        agentEndpointFingerprint(adapted.registration)
      );
      try {
        result = await agentEndpointGateway.activateEndpoint(activation);
      } catch (error) {
        result = {
          ok: false,
          error: `terminal daemon unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
      if (!result.ok) {
        const failure = gatewayFailure(result);
        sendJson(res, failure.status, failure.body);
        return true;
      }
      if (
        result.body?.ok !== true ||
        (result.body.kind !== 'activated' && result.body.kind !== 'already-active')
      ) {
        sendJson(res, 502, {
          ok: false,
          error: 'terminal daemon returned malformed agent endpoint activation receipt'
        });
        return true;
      }
      sendJson(res, result.status ?? 200, result.body);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const requested = Number(url.searchParams.get('limit'));
      const limit =
        Number.isSafeInteger(requested) && requested > 0
          ? Math.min(requested, 1_000)
          : 200;
      let result: DaemonControlResult;
      try {
        result = await deskEventGateway.readEvents(limit);
      } catch (error) {
        result = {
          ok: false,
          error: `terminal daemon unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
      if (!result.ok) {
        const failure = gatewayFailure(result);
        sendJson(res, failure.status, failure.body);
        return true;
      }
      try {
        const feed = parseDeskEventFeedResponse({
          schemaVersion: result.body?.schemaVersion,
          latestSeq: result.body?.latestSeq,
          unread: result.body?.unread,
          items: result.body?.items
        });
        if (result.body?.ok !== true) throw new Error('missing ok');
        sendJson(res, 200, feed);
      } catch {
        sendJson(res, 502, {
          ok: false,
          error: 'terminal daemon returned malformed event feed'
        });
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/events/read') {
      const body = await readJsonBody(req);
      let input: DeskEventReadRequest;
      try {
        input = parseDeskEventReadRequest(body);
      } catch {
        sendJson(res, 400, {
          ok: false,
          error: 'invalid event read request'
        });
        return true;
      }
      let result: DaemonControlResult;
      try {
        result = await deskEventGateway.markEventsRead(input);
      } catch (error) {
        result = {
          ok: false,
          error: `terminal daemon unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
      if (!result.ok) {
        const failure = gatewayFailure(result);
        sendJson(res, failure.status, failure.body);
        return true;
      }
      try {
        sendJson(res, 200, parseDeskEventReadResponse(result.body));
      } catch {
        sendJson(res, 502, {
          ok: false,
          error: 'terminal daemon returned malformed event read receipt'
        });
      }
      return true;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/events') {
      let result: DaemonControlResult;
      try {
        result = await deskEventGateway.clearEvents();
      } catch (error) {
        result = {
          ok: false,
          error: `terminal daemon unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
      if (!result.ok) {
        const failure = gatewayFailure(result);
        sendJson(res, failure.status, failure.body);
        return true;
      }
      try {
        sendJson(res, 200, parseDeskEventClearResponse(result.body));
      } catch {
        sendJson(res, 502, {
          ok: false,
          error: 'terminal daemon returned malformed event clear receipt'
        });
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/kill-all') {
      const result = await executeKillSwitch();
      managedAgentLsp.cleanupAll();
      sendJson(res, 200, result);
      return true;
    }

    return false;
  };
}
