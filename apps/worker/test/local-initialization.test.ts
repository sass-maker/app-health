import { expect, it } from 'vitest';
import worker from '../src/index.js';

it('concurrent first local requests share one initialized project store', async () => {
  const env = { APP_HEALTH_MODE: 'local' };
  const responses = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      worker.fetch(
        new Request('http://local/v1/apps', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `Concurrent ${index}`,
            environment: 'production',
            key_scope: 'environment',
          }),
        }),
        env,
      ),
    ),
  );
  const projects = (await Promise.all(responses.map((response) => response.json()))) as {
    app: { id: string };
    environment: { id: string };
  }[];
  const listed = (await (await worker.fetch(new Request('http://local/v1/apps'), env)).json()) as {
    apps: { app: { id: string } }[];
  };
  for (const project of projects) {
    expect(listed.apps.some((row) => row.app.id === project.app.id)).toBe(true);
    const result = await worker.fetch(
      new Request(
        `http://local/v1/capabilities?app_id=${project.app.id}&environment_id=${project.environment.id}`,
      ),
      env,
    );
    expect(result.status).toBe(200);
  }
});
