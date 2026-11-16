import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CatalogPublisherEnrollmentResponseV1,
  CatalogPublisherStatusV1,
  projectCanonicalCatalogWithRevisions,
} from '@app-health/contracts';

type FailureCode =
  'invalid_catalog' | 'source_unavailable' | 'service_unavailable' | 'review_required' | 'conflict';
export class PublisherFailure extends Error {
  readonly code: FailureCode;
  readonly status?: number;
  constructor(code: FailureCode, status?: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export interface PublisherConfig {
  origin: string;
  catalog: string;
  publisherId: string;
  code: string;
}
function validateTarget(origin: string, path: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(origin);
  } catch {
    throw new PublisherFailure('service_unavailable');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.origin !== origin ||
    endpoint.username ||
    endpoint.password ||
    !/^\/v1\/catalog\/publisher(?:\/(?:enroll|error))?$/.test(path)
  )
    throw new PublisherFailure('service_unavailable');
}
async function readResponseJson(response: Response) {
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        throw new Error('response limit');
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new PublisherFailure('service_unavailable');
  }
}
export async function publisherRequest(
  origin: string,
  path: string,
  secret: string | null,
  body?: unknown,
) {
  validateTarget(origin, path);
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PublisherFailure('service_unavailable');
  }
  if (response.url && new URL(response.url).origin !== origin)
    throw new PublisherFailure('service_unavailable');
  if (!response.ok)
    throw new PublisherFailure(
      response.status === 409 ? 'review_required' : 'service_unavailable',
      response.status,
    );
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new PublisherFailure('service_unavailable');
  return readResponseJson(response);
}

export async function enrollPublisher(origin: string, label: string) {
  return CatalogPublisherEnrollmentResponseV1.parse(
    await publisherRequest(origin, '/v1/catalog/publisher/enroll', null, { label }),
  );
}

async function readBoundedCatalog(path: string) {
  const file = await open(path, 'r');
  try {
    const maximum = 8 * 1024 * 1024;
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > maximum) throw new PublisherFailure('invalid_catalog');
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, null);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size > maximum) throw new PublisherFailure('invalid_catalog');
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

async function sourceProjection(path: string, stableDelay: number) {
  let first: Buffer;
  let second: Buffer;
  try {
    first = await readBoundedCatalog(path);
    if (first.length > 8 * 1024 * 1024) throw new PublisherFailure('invalid_catalog');
    await delay(stableDelay);
    second = await readBoundedCatalog(path);
  } catch (error) {
    if (error instanceof PublisherFailure) throw error;
    throw new PublisherFailure('source_unavailable');
  }
  if (!first.equals(second)) throw new PublisherFailure('source_unavailable');
  try {
    return await projectCanonicalCatalogWithRevisions(JSON.parse(second.toString('utf8')), null);
  } catch {
    throw new PublisherFailure('invalid_catalog');
  }
}

export async function checkCatalogSource(path: string) {
  const projection = await sourceProjection(path, 500);
  return { state: 'source_readable', count: projection.projects.length };
}

export async function publishOnce(config: PublisherConfig, secret: string, stableDelay = 500) {
  let projection: Awaited<ReturnType<typeof projectCanonicalCatalogWithRevisions>>;
  try {
    projection = await sourceProjection(config.catalog, stableDelay);
  } catch (error) {
    const failure =
      error instanceof PublisherFailure ? error : new PublisherFailure('invalid_catalog');
    await publisherRequest(config.origin, '/v1/catalog/publisher/error', secret, {
      error: failure.code,
    }).catch(() => undefined);
    throw failure;
  }
  for (let retry = 0; retry < 2; retry += 1) {
    const status = CatalogPublisherStatusV1.parse(
      await publisherRequest(config.origin, '/v1/catalog/publisher', secret),
    );
    if (status.publisher_id !== config.publisherId)
      throw new PublisherFailure('service_unavailable');
    if (status.state === 'pending') return { state: 'pending' as const, count: null };
    const projectedHash = createHash('sha256')
      .update(JSON.stringify({ projects: projection.projects, monitoring: projection.monitoring }))
      .digest('hex');
    if (
      status.projection_hash === projectedHash &&
      status.project_count === projection.projects.length
    ) {
      await publisherRequest(config.origin, '/v1/catalog/publisher/error', secret, { error: null });
      return { state: 'current' as const, count: projection.projects.length };
    }
    try {
      await commitProjection(config, secret, projection, status.projection_hash, projectedHash);
      return { state: 'synchronized' as const, count: projection.projects.length };
    } catch (error) {
      if (!(error instanceof PublisherFailure) || error.status !== 409 || retry) throw error;
      projection = await sourceProjection(config.catalog, stableDelay);
    }
  }
  throw new PublisherFailure('conflict');
}

async function commitProjection(
  config: PublisherConfig,
  secret: string,
  projection: Awaited<ReturnType<typeof projectCanonicalCatalogWithRevisions>>,
  previousHash: string | null,
  projectedHash: string,
) {
  const acknowledgement = (await publisherRequest(config.origin, '/v1/catalog/publisher', secret, {
    ...projection,
    expected_previous_hash: previousHash,
  })) as { projection_hash?: unknown; project_count?: unknown } | null;
  if (
    acknowledgement?.projection_hash !== projectedHash ||
    acknowledgement.project_count !== projection.projects.length
  )
    throw new PublisherFailure('service_unavailable');
  const readback = CatalogPublisherStatusV1.parse(
    await publisherRequest(config.origin, '/v1/catalog/publisher', secret),
  );
  if (
    readback.state !== 'approved' ||
    readback.publisher_id !== config.publisherId ||
    readback.projection_hash !== projectedHash ||
    readback.project_count !== projection.projects.length
  )
    throw new PublisherFailure('conflict');
}
