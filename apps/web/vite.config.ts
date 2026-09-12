import { defineConfig, type Plugin } from 'vite';
import { configDefaults, coverageConfigDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface LocalWorkerModule {
  default: {
    fetch(request: Request, env: { APP_HEALTH_MODE: string }): Promise<Response>;
  };
}

interface ShadcnSource {
  path: string;
}

const shadcnSources = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../docs/shadcn-sources.json'), 'utf8'),
) as ShadcnSource[];
const shadcnCoverageExcludes = shadcnSources.map(({ path }) => path.replace(/^apps\/web\//u, ''));

/** Serve the credential-free in-memory Worker through Vite during local development. */
function localWorkerApi(): Plugin {
  return {
    name: 'app-health-local-worker',
    configureServer(server) {
      let workerModule: Promise<LocalWorkerModule> | null = null;
      server.middlewares.use('/v1', (request, response) => {
        void (async () => {
          workerModule ??= server.ssrLoadModule(
            '/@fs/' + new URL('../worker/src/index.ts', import.meta.url).pathname,
          ) as Promise<LocalWorkerModule>;
          const worker = (await workerModule).default;
          const chunks: Uint8Array[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (typeof value === 'string') headers.set(name, value);
            else if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          }
          const path = request.originalUrl ?? request.url ?? '/';
          const method = request.method ?? 'GET';
          const webRequest = new Request(`http://${request.headers.host ?? 'localhost'}${path}`, {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : body,
          });
          const webResponse = await worker.fetch(webRequest, { APP_HEALTH_MODE: 'local' });
          response.statusCode = webResponse.status;
          webResponse.headers.forEach((value, name) => response.setHeader(name, value));
          response.end(Buffer.from(await webResponse.arrayBuffer()));
        })().catch((error: unknown) => {
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({ error: error instanceof Error ? error.message : 'local API error' }),
          );
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), localWorkerApi()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        live: resolve(import.meta.dirname, 'live.html'),
        changelog: resolve(import.meta.dirname, 'changelog.html'),
      },
    },
  },
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    coverage: {
      exclude: [
        ...coverageConfigDefaults.exclude,
        'e2e/**',
        'playwright.config.ts',
        '**/scripts/*.d.mts',
        ...shadcnCoverageExcludes,
      ],
    },
  },
});
