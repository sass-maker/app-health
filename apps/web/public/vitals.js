(() => {
  const script = globalThis.document.currentScript;
  if (!script || !script.dataset.key?.startsWith('ahk_pub_')) return;
  // The tracker leaves a stopped placeholder when it is stopped while this file is downloading.
  if (globalThis.window.appHealthVitals?.stopped) return;
  const endpoint = script.dataset.endpoint || 'https://ingest.sassmaker.com/v1/browser';
  let stopVitals = () => {};

  function routeGroup() {
    // The tracker passes the document's own path so a later SPA route change cannot relabel it.
    const path = script.dataset.vitalsPath || globalThis.location.pathname;
    const part = path.split('/')[1].toLowerCase();
    if (!part) return path === '/' ? '/' : '/other';
    // Optional owner allowlist (data-vitals-routes="docs,pricing"): everything else is /other.
    const known = script.dataset.vitalsRoutes;
    if (
      known !== undefined &&
      !known
        .toLowerCase()
        .split(',')
        .map((name) => name.trim())
        .includes(part)
    )
      return '/other';
    const id = /^(?:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{16,})$/;
    return /^[a-z0-9_-]{1,40}$/.test(part) && !id.test(part) ? '/' + part : '/other';
  }
  function vitalsEnabled() {
    if (globalThis.navigator.webdriver) return false;
    const sample = Number(script.dataset.vitalsSample);
    return Math.random() < (sample > 0 && sample <= 1 ? sample : 1);
  }
  function sendVitals(props) {
    const target = script.dataset.vitalsEndpoint || endpoint.replace(/\/v1\/browser$/, '/v1/logs');
    const body = JSON.stringify({
      schema_version: 'v1',
      public_key: script.dataset.key,
      batch_id: globalThis.crypto.randomUUID(),
      logs: [
        {
          log_id: globalThis.crypto.randomUUID(),
          timestamp: Date.now(),
          event: 'web.vitals',
          level: 'debug',
          props,
        },
      ],
    });
    try {
      if (
        globalThis.navigator.sendBeacon?.(
          target,
          new globalThis.Blob([body], { type: 'text/plain' }),
        )
      )
        return;
    } catch {
      // A denied beacon can still use the credential-free keepalive fallback.
    }
    void globalThis
      .fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        credentials: 'omit',
        keepalive: true,
        body,
      })
      .catch(() => {});
  }
  function startVitals() {
    if (globalThis.document.prerendering) {
      // Activation time and visibility are only meaningful once the page is shown.
      globalThis.document.addEventListener('prerenderingchange', startVitals, { once: true });
      return;
    }
    if (!vitalsEnabled()) return;
    const nav = globalThis.performance.getEntriesByType?.('navigation')[0];
    // Prerendered documents are timed from activation, not from when the browser started them.
    const activation = nav?.activationStart > 0 ? nav.activationStart : 0;
    const props = {
      route_group: routeGroup(),
      nav_type: ['navigate', 'reload', 'back_forward', 'prerender'].includes(nav?.type)
        ? nav.type
        : 'navigate',
    };
    if (activation) props.nav_type = 'prerender';
    const ms = (value) => Math.round(Math.max(0, Math.min(600000, value)));
    if (Number.isFinite(nav?.responseStart) && nav.responseStart !== 0)
      props.ttfb_ms = ms(nav.responseStart - activation);
    const observers = [];
    const interactions = new Map();
    const inputs = ['keydown', 'click', 'pointerdown'];
    let lcp;
    let lcpDone = false;
    let sent = false;
    let windowStart = 0;
    let lastShift = 0;
    let windowSum = 0;
    // Paints in a background tab include the wait before it was first shown, so they are ignored.
    let firstHidden = globalThis.document.visibilityState === 'hidden' ? 0 : Infinity;
    function largestPaint(entry) {
      if (!lcpDone && Number.isFinite(entry.startTime) && entry.startTime < firstHidden)
        props.lcp_ms = ms(entry.startTime - activation);
    }
    function layoutShift(entry) {
      if (entry.hadRecentInput || !Number.isFinite(entry.value)) return;
      if (
        !windowSum ||
        entry.startTime - lastShift >= 1000 ||
        entry.startTime - windowStart >= 5000
      ) {
        windowStart = entry.startTime;
        windowSum = 0;
      }
      lastShift = entry.startTime;
      windowSum += entry.value;
      props.cls_milli = Math.max(
        props.cls_milli || 0,
        Math.min(10000, Math.round(windowSum * 1000)),
      );
    }
    function interaction(entry) {
      if (!entry.interactionId || !Number.isFinite(entry.duration)) return;
      interactions.set(
        entry.interactionId,
        Math.max(interactions.get(entry.interactionId) || 0, entry.duration),
      );
    }
    function observe(type, record) {
      try {
        const supported = globalThis.PerformanceObserver?.supportedEntryTypes;
        if (supported && !supported.includes(type)) return undefined;
        const observer = new globalThis.PerformanceObserver((list) => {
          try {
            if (!sent) list.getEntries().forEach(record);
          } catch {
            // Performance telemetry must not affect the host page.
          }
        });
        observer.observe({
          type,
          buffered: true,
          ...(type === 'event' ? { durationThreshold: 40 } : {}),
        });
        observers.push({ observer, record });
        return observer;
      } catch {
        return undefined;
      }
    }
    function drain(observer, record) {
      try {
        observer?.takeRecords().forEach(record);
      } catch {
        // Unsupported or disconnected observers have no remaining metrics.
      }
    }
    function finishLcp() {
      drain(lcp, largestPaint);
      lcpDone = true;
      disconnect(lcp);
      inputs.forEach((type) => globalThis.document.removeEventListener(type, finishLcp, true));
    }
    function disconnect(observer) {
      try {
        observer?.disconnect();
      } catch {
        // Observer failures must not affect page behavior.
      }
    }
    function cleanup() {
      sent = true;
      observers.forEach(({ observer }) => disconnect(observer));
      inputs.forEach((type) => globalThis.document.removeEventListener(type, finishLcp, true));
      globalThis.document.removeEventListener('visibilitychange', hidden);
      globalThis.window.removeEventListener('pagehide', report);
    }
    function report() {
      if (sent) return;
      observers.forEach(({ observer, record }) => drain(observer, record));
      sent = true;
      cleanup();
      try {
        const durations = [...interactions.values()].sort((a, b) => b - a);
        // Event Timing only reports slow events, so prefer the browser's total interaction count;
        // interactions that were all faster than the threshold are a measured zero.
        const total = globalThis.performance.interactionCount;
        const count = Number.isFinite(total) && total > 0 ? total : durations.length;
        const rank = Math.floor(count / 50);
        if (durations.length) props.inp_ms = rank < durations.length ? ms(durations[rank]) : 0;
        else if (count > 0) props.inp_ms = 0;
        const measured = ['lcp_ms', 'inp_ms', 'ttfb_ms'].some((name) => props[name] !== undefined);
        if (measured || props.cls_milli > 0) sendVitals(props);
      } catch {
        // Delivery is best effort, with no retries or diagnostics changes.
      }
    }
    function hidden() {
      if (globalThis.document.visibilityState === 'hidden') {
        firstHidden = Math.min(firstHidden, globalThis.performance.now?.() ?? 0);
        report();
      }
    }
    stopVitals = cleanup;
    lcp = observe('largest-contentful-paint', largestPaint);
    // A supported observer with no shifts is a measured zero, not a missing metric.
    if (observe('layout-shift', layoutShift)) props.cls_milli = 0;
    observe('event', interaction);
    inputs.forEach((type) => globalThis.document.addEventListener(type, finishLcp, true));
    globalThis.document.addEventListener('visibilitychange', hidden);
    globalThis.window.addEventListener('pagehide', report);
  }

  globalThis.window.appHealthVitals = { stop: () => stopVitals() };
  try {
    startVitals();
  } catch {
    stopVitals();
  }
})();
