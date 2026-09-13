import { useReportCache } from './AnalyticsCache.js';
import { useEffect, useRef, useState } from 'react';
import {
  BrowserReport,
  type BrowserSegmentFilter,
  BrowserSummary,
  PresenceSnapshot,
  type BrowserSummary as BrowserSummaryData,
  type BrowserReport as BrowserReportData,
} from '@app-health/contracts';

const ANALYTICS_TIMEOUT_MS = 8_000;

function timedRequest() {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ANALYTICS_TIMEOUT_MS);
  return { controller, expired: () => expired, clear: () => clearTimeout(timer) };
}

function responseError(body: unknown, fallback: string) {
  return typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
    ? body.error
    : fallback;
}

async function readSummary(response: Response): Promise<BrowserSummaryData> {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(responseError(body, 'Analytics is unavailable.'));
  const parsed = BrowserSummary.safeParse(body);
  if (!parsed.success) {
    throw new Error('Analytics is unavailable.');
  }
  return parsed.data;
}

async function readReport(response: Response): Promise<BrowserReportData> {
  if (!response.ok) throw new Error('Reports are unavailable. Please try again.');
  const parsed = BrowserReport.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Reports are unavailable. Please try again.');
  }
  return parsed.data;
}

function requestCanUpdate(
  cancelled: boolean,
  hidden: boolean,
  controller: AbortController,
  timedOut: boolean,
) {
  return !cancelled && !hidden && (timedOut || !controller.signal.aborted);
}

function requestError(cause: unknown, timedOut: boolean, fallback: string) {
  if (timedOut) return `${fallback} request timed out. Please try again.`;
  return cause instanceof Error ? cause.message : `${fallback} is unavailable.`;
}

function createWorkspaceSocket(
  isPaused: () => boolean,
  onConnected: (connected: boolean) => void,
  onLive: (live: PresenceSnapshot) => void,
) {
  let socket: WebSocket | undefined;
  let retiredSocket: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  function clearReconnect() {
    if (reconnect) clearTimeout(reconnect);
    reconnect = undefined;
  }

  function connect() {
    if (isPaused() || socket) return;
    const url = new URL('/v1/analytics/live', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = new WebSocket(url);
    socket = current;
    current.onopen = () => {
      if (!isPaused() && socket === current) onConnected(true);
    };
    current.onmessage = (event) => {
      try {
        const frame = PresenceSnapshot.safeParse(JSON.parse(String(event.data)));
        if (!isPaused() && socket === current && frame.success) onLive(frame.data);
      } catch {
        /* An invalid frame never replaces the last reading. */
      }
    };
    current.onclose = (event) => {
      if (!isPaused() && socket === current) {
        socket = undefined;
        retiredSocket = current;
        onConnected(false);
        reconnect = setTimeout(connect, event?.code === 4001 ? 0 : 5000);
      }
    };
    current.onerror = () => current.close();
  }

  function close() {
    clearReconnect();
    const current = socket;
    socket = undefined;
    current?.close();
    if (retiredSocket && retiredSocket !== current) retiredSocket.close();
    retiredSocket = undefined;
  }

  return { connect, close };
}

export function useWorkspaceAnalytics(ownerToken: string) {
  const [data, setData] = useState<BrowserSummaryData | null>(null);
  const [live, setLive] = useState<PresenceSnapshot | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let hidden = document.hidden;
    let loading = false;
    let request: AbortController | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    setData(null);
    setLive(null);
    setConnected(false);
    setError('');
    const sockets = createWorkspaceSocket(
      () => cancelled || hidden,
      (value) => setConnected(value),
      (value) => setLive(value),
    );
    async function load() {
      if (cancelled || hidden || loading) return;
      loading = true;
      const timeout = timedRequest();
      const { controller } = timeout;
      request = controller;
      try {
        const response = await fetch('/v1/analytics', {
          signal: controller.signal,
          headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
        });
        const next = await readSummary(response);
        if (cancelled || hidden || controller.signal.aborted) return;
        setData(next);
        setLive((current) =>
          current && current.measured_at > next.live.measured_at ? current : next.live,
        );
        setError('');
        if (next.stream) sockets.connect();
      } catch (cause) {
        if (requestCanUpdate(cancelled, hidden, controller, timeout.expired()))
          setError(requestError(cause, timeout.expired(), 'Analytics'));
      } finally {
        timeout.clear();
        if (request === controller) {
          request = undefined;
          loading = false;
        }
      }
    }
    function onVisibilityChange() {
      hidden = document.hidden;
      if (poll) clearInterval(poll);
      if (hidden) {
        if (poll) clearInterval(poll);
        poll = undefined;
        request?.abort();
        loading = false;
        sockets.close();
        setConnected(false);
      } else {
        poll = setInterval(() => void load(), import.meta.env.DEV ? 5000 : 60_000);
        if (!import.meta.env.DEV) sockets.connect();
        void load();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!hidden && !import.meta.env.DEV) sockets.connect();
    if (!hidden) void load();
    if (!hidden) poll = setInterval(() => void load(), import.meta.env.DEV ? 5000 : 60_000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      request?.abort();
      if (poll) clearInterval(poll);
      sockets.close();
    };
  }, [ownerToken, retry]);
  return { data, live, error, connected, reload: () => setRetry((value) => value + 1) };
}

type ReportOptions =
  | 'audience'
  | 'acquisition'
  | 'technology'
  | {
      breakdown: 'audience' | 'acquisition' | 'technology';
      segments: BrowserSegmentFilter;
    };

function reportParameters(
  range: string,
  appId: string,
  environmentId: string,
  event: string,
  breakdown: string,
  segmentQuery: string,
) {
  const params = new URLSearchParams({ range });
  if (appId) params.set('app_id', appId);
  if (environmentId) params.set('environment_id', environmentId);
  if (event) params.set('event', event);
  if (breakdown !== 'audience') params.set('breakdown', breakdown);
  new URLSearchParams(segmentQuery).forEach((value, key) => params.set(key, value));
  return params;
}

function useReportState(scope: string) {
  const cache = useReportCache();
  const cached = cache.read(scope);
  const [report, setReport] = useState<BrowserReportData | null>(cached);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!cached);
  const [retry, setRetry] = useState(0);
  const reportDataScopeRef = useRef<string | null>(cached ? scope : null);
  return {
    cache,
    report,
    setReport,
    error,
    setError,
    loading,
    setLoading,
    retry,
    setRetry,
    reportDataScopeRef,
  };
}

function reportConfiguration(
  range: string,
  appId: string,
  environmentId: string,
  event: string,
  options: ReportOptions,
) {
  const breakdown = typeof options === 'string' ? options : options.breakdown;
  const segmentQuery = new URLSearchParams(
    typeof options === 'string' ? [] : Object.entries(options.segments).sort(),
  ).toString();
  return reportParameters(range, appId, environmentId, event, breakdown, segmentQuery);
}

export function useBrowserReport(
  ownerToken: string,
  range: string,
  appId: string,
  environmentId: string,
  event: string,
  options: ReportOptions = 'audience',
) {
  const params = reportConfiguration(range, appId, environmentId, event, options);
  const scope = JSON.stringify([ownerToken, params.toString()]);
  const state = useReportState(scope);
  useEffect(() => {
    let cancelled = false;
    let hidden = document.hidden;
    let loading = false;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const hit = state.retry === 0 ? state.cache.read(scope) : null;
    const preserveReport = state.reportDataScopeRef.current === scope;
    if (hit) {
      state.setReport(hit);
      state.reportDataScopeRef.current = scope;
    }
    if (!preserveReport && !hit) state.setReport(null);
    state.setLoading(!preserveReport && !hit);
    state.setError('');
    async function load() {
      if (cancelled || hidden || loading) return;
      loading = true;
      const timeout = timedRequest();
      const { controller } = timeout;
      request = controller;
      try {
        const response = await fetch(`/v1/analytics/report?${params}`, {
          signal: controller.signal,
          headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
          cache: 'no-store',
        });
        const parsed = await readReport(response);
        if (!cancelled && !controller.signal.aborted) {
          state.cache.write(scope, parsed);
          state.setReport(parsed);
          state.reportDataScopeRef.current = scope;
          state.setError('');
        }
      } catch (cause) {
        if (requestCanUpdate(cancelled, hidden, controller, timeout.expired()))
          state.setError(requestError(cause, timeout.expired(), 'Report'));
      } finally {
        timeout.clear();
        if (request === controller && (!controller.signal.aborted || timeout.expired()))
          state.setLoading(false);
        if (request === controller) {
          request = undefined;
          loading = false;
        }
      }
    }
    function onVisibilityChange() {
      hidden = document.hidden;
      if (timer) clearInterval(timer);
      if (hidden) {
        if (timer) clearInterval(timer);
        timer = undefined;
        request?.abort();
        loading = false;
      } else {
        timer = setInterval(() => void load(), 60_000);
        void load();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!hidden && !hit) void load();
    if (!hidden) timer = setInterval(() => void load(), 60000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      request?.abort();
      if (timer) clearInterval(timer);
    };
  }, [ownerToken, scope, state.retry]);
  return {
    report: state.reportDataScopeRef.current === scope ? state.report : null,
    error: state.error,
    loading: state.loading,
    reload: () => state.setRetry((value) => value + 1),
  };
}
