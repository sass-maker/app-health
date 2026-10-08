// Response checks. A journey passes only when the complete body is the usable
// result: expected status and type, required markers, and semantic JSON
// invariants. Details are fixed descriptions; body content is never echoed.

import type { FailureKind, HttpResult } from './measure.ts';
import type { Expectation, JsonCheck } from './spec.ts';

export interface Verdict {
  failure?: FailureKind;
  detail?: string;
}

function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function checkJson(parsed: unknown, check: JsonCheck): string | undefined {
  const value = valueAt(parsed, check.path);
  if (check.min_items !== undefined) {
    if (!Array.isArray(value)) return `${check.path} is not a list`;
    if (value.length < check.min_items)
      return `${check.path} has ${value.length} of ${check.min_items} required items`;
  }
  if (check.equals !== undefined && value !== check.equals)
    return `${check.path} has an unexpected value`;
  if (check.min_items === undefined && check.equals === undefined && value === undefined)
    return `${check.path} is missing`;
  return undefined;
}

function checkBody(body: string, expect: Expectation): Verdict {
  const missing = expect.body_includes.findIndex((marker) => !body.includes(marker));
  if (missing >= 0) return { failure: 'semantic', detail: `body marker ${missing} missing` };
  if (expect.json.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { failure: 'parse', detail: 'body is not valid JSON' };
  }
  for (const check of expect.json) {
    const problem = checkJson(parsed, check);
    if (problem) return { failure: 'semantic', detail: problem };
  }
  return {};
}

/** Judge a completed transport result against the journey's expectation. */
export function validateResponse(result: HttpResult, expect: Expectation): Verdict {
  if (result.failure) return { failure: result.failure };
  if (result.status !== expect.status)
    return { failure: 'http', detail: `status ${result.status ?? 'missing'}` };
  const type = (result.contentType ?? '').toLowerCase();
  if (expect.content_type && !type.startsWith(expect.content_type.toLowerCase()))
    return { failure: 'content_type', detail: 'unexpected content type' };
  return checkBody(result.body?.toString('utf8') ?? '', expect);
}

/** First same-origin script or stylesheet referenced by an HTML document. */
export function firstPartyAsset(html: string, pageUrl: string): string | undefined {
  const origin = new URL(pageUrl).origin;
  const pattern =
    /<(?:script\b[^>]*\bsrc|link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const url = new URL(match[1] ?? '', pageUrl);
      if (url.origin === origin) {
        url.hash = '';
        return url.toString();
      }
    } catch {
      continue;
    }
  }
  return undefined;
}
