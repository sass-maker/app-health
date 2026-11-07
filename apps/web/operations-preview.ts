import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { currentOperationsSnapshot, readOperationsSnapshot } from './src/lib/operations-model.js';

const MAXIMUM_BYTES = 8 * 1024 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

type PreviewRequest = Pick<IncomingMessage, 'headers' | 'method'> & {
  socket?: { remoteAddress?: string };
};
export function operationsRequestAllowed(request: PreviewRequest): boolean {
  if (
    request.method !== 'GET' ||
    request.headers['x-workspace-id'] ||
    request.headers['x-app-health-workspace']
  )
    return false;
  if (
    request.socket?.remoteAddress &&
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
  )
    return false;
  try {
    const host = new URL(`http://${request.headers.host ?? ''}`);
    if (!LOOPBACK.has(host.hostname) || host.username || host.password) return false;
    const origin = request.headers.origin;
    if (origin && new URL(origin).origin !== host.origin) return false;
    return !['cross-site', 'same-site'].includes(String(request.headers['sec-fetch-site'] ?? ''));
  } catch {
    return false;
  }
}

export async function operationsPreviewResponse(
  request: PreviewRequest,
  snapshotFile?: string,
): Promise<{ status: number; body: unknown }> {
  if (!operationsRequestAllowed(request))
    return { status: 403, body: { error: 'Operations preview requires the local owner context.' } };
  if (!snapshotFile)
    return {
      status: 404,
      body: { error: 'No operations sources are connected to this local preview.' },
    };
  try {
    if ((await stat(snapshotFile)).size > MAXIMUM_BYTES) throw new Error('Snapshot too large');
    const body = await readFile(snapshotFile, 'utf8');
    if (Buffer.byteLength(body) > MAXIMUM_BYTES) throw new Error('Snapshot too large');
    const snapshot = readOperationsSnapshot(JSON.parse(body));
    return { status: 200, body: currentOperationsSnapshot(snapshot) };
  } catch {
    return {
      status: 503,
      body: {
        error:
          'The private operations snapshot is unavailable or invalid. Collect it again and reload.',
      },
    };
  }
}

function writeResponse(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify(body));
}

export function operationsPreview(): Plugin {
  return {
    name: 'app-health-private-operations-preview',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/v1/workspace/operations') return next();
        void operationsPreviewResponse(request, process.env.APP_HEALTH_OPERATIONS_FILE).then(
          ({ status, body }) => writeResponse(response, status, body),
        );
      });
    },
  };
}
