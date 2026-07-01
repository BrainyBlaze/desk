#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDeskLspMcpServer } from './deskLspMcp.js';

const server = createDeskLspMcpServer();
const transport = new StdioServerTransport();

await server.connect(transport);
