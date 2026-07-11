import type { Server as NodeHttpServer } from 'node:http';
import type { Connect } from 'vite';

export interface DeskApiHost {
  httpServer: NodeHttpServer | null;
  middlewares: Connect.Server;
}
