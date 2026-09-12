import { useEffect, useState } from 'react';
import {
  BrowserReport,
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
        setLive(next.live);
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
      if (hidden) {
        request?.abort();
        loading = false;
        sockets.close();
        setConnected(false);
      } else {
        void load();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!hidden) void load();
    const poll = setInterval(() => void load(), import.meta.env.DEV ? 5000 : 60_000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      request?.abort();
      clearInterval(poll);
      sockets.close();
    };
  }, [ownerToken, retry]);
  return { data, live, error, connected, reload: () => setRetry((value) => value + 1) };
}

export function useBrowserReport(
  ownerToken: string,
  range: string,
  appId: string,
  environmentId: string,
  event: string,
) {
  const [report, setReport] = useState<BrowserReportData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let hidden = document.hidden;
    let loading = false;
    let request: AbortController | undefined;
    const params = new URLSearchParams({ range });
    if (appId) params.set('app_id', appId);
    if (environmentId) params.set('environment_id', environmentId);
    if (event) params.set('event', event);
    setReport(null);
    setLoading(true);
    setError('');
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
        });
        const parsed = await readReport(response);
        if (!cancelled && !controller.signal.aborted) {
          setReport(parsed);
          setError('');
        }
      } catch (cause) {
        if (requestCanUpdate(cancelled, hidden, controller, timeout.expired()))
          setError(requestError(cause, timeout.expired(), 'Report'));
      } finally {
        timeout.clear();
        if (request === controller && (!controller.signal.aborted || timeout.expired()))
          setLoading(false);
        if (request === controller) {
          request = undefined;
          loading = false;
        }
      }
    }
    function onVisibilityChange() {
      hidden = document.hidden;
      if (hidden) {
        request?.abort();
        loading = false;
      } else {
        void load();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!hidden) void load();
    const timer = setInterval(() => void load(), 60000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      request?.abort();
      clearInterval(timer);
    };
  }, [ownerToken, range, appId, environmentId, event, retry]);
  return { report, error, loading, reload: () => setRetry((value) => value + 1) };
}
