(() => {
  const script = document.currentScript;
  if (!script || window.appHealth || !script.dataset.key?.startsWith('ahk_pub_')) return;
  const endpoint = script.dataset.endpoint || 'https://ingest.sassmaker.com/v1/browser';
  const queue = [];
  let pending = null;
  let sending = false;
  let request;
  let timer;
  let stopped = false;
  let lastPath = '';
  let session;
  const diagnostics = { accepted: 0, dropped: 0, retries: 0 };

  function sessionId() {
    const now = Date.now();
    try {
      session ||= JSON.parse(sessionStorage.getItem('app-health-session-v1') || 'null');
    } catch {
      /* Optional. */
    }
    if (
      !session ||
      !/^[a-f0-9-]{36}$/.test(session.id) ||
      now - session.seen > 1800000 ||
      session.day !== new Date(now).toISOString().slice(0, 10)
    ) {
      session = {
        id: crypto.randomUUID(),
        day: new Date(now).toISOString().slice(0, 10),
        seen: now,
      };
    }
    session.seen = now;
    try {
      sessionStorage.setItem('app-health-session-v1', JSON.stringify(session));
    } catch {
      /* Optional. */
    }
    return session.id;
  }

  function safePath(value) {
    try {
      const path = new URL(value, location.href).pathname;
      const safe = path
        .split('/')
        .map((part) => {
          const decoded = decodeURIComponent(part);
          return /[@?\s#\\]/.test(decoded) || /\d/.test(decoded) || decoded.length > 40
            ? ':id'
            : part;
        })
        .join('/');
      return safe.length > 256 ? '/:path' : safe;
    } catch {
      return '/';
    }
  }

  function referrer() {
    try {
      const host = document.referrer ? new URL(document.referrer).hostname : '';
      return host !== location.hostname && /^[a-z0-9.-]*$/i.test(host) ? host : '';
    } catch {
      return '';
    }
  }

  function schedule(delay = 1500) {
    if (!stopped && !timer && document.visibilityState !== 'hidden')
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
  }

  function payload() {
    if (!pending)
      pending = {
        attempts: 0,
        events: queue.splice(0, 25),
        batch_id: crypto.randomUUID(),
        session_id: sessionId(),
      };
    return JSON.stringify({
      schema_version: 1,
      public_key: script.dataset.key,
      batch_id: pending.batch_id,
      session_id: pending.session_id,
      events: pending.events,
    });
  }

  async function flush() {
    if (stopped || sending || document.visibilityState === 'hidden') return;
    clearTimeout(timer);
    timer = null;
    const body = payload();
    sending = true;
    const attempt = pending;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        credentials: 'omit',
        body,
        keepalive: true,
        signal: controller.signal,
      });
      if (!response.ok && (response.status === 429 || response.status >= 500)) throw new Error();
      if (response.ok) diagnostics.accepted += attempt.events.length;
      else diagnostics.dropped += attempt.events.length;
      pending = null;
    } catch {
      attempt.attempts++;
      diagnostics.retries++;
      if (attempt.attempts >= 3) {
        diagnostics.dropped += attempt.events.length;
        pending = null;
      }
    } finally {
      clearTimeout(timeout);
      request = null;
      sending = false;
      if (pending || queue.length) schedule(1500 * Math.pow(2, attempt.attempts));
    }
  }

  function emit(type, name, path) {
    if (stopped || queue.length >= 100) {
      diagnostics.dropped++;
      return;
    }
    queue.push({
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      path: safePath(path),
      referrer: referrer(),
      ...(name ? { name } : {}),
    });
    schedule();
  }
  function page(path = location.pathname) {
    lastPath = location.pathname;
    emit('pageview', undefined, path);
  }
  function track(name) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(name)) {
      diagnostics.dropped++;
      return;
    }
    emit('event', name, location.pathname);
  }
  function navigation() {
    if (location.pathname !== lastPath) page();
  }
  function beacon() {
    if (pending || queue.length) {
      try {
        navigator.sendBeacon(endpoint, new Blob([payload()], { type: 'text/plain' }));
      } catch {
        /* Not acknowledged. */
      }
    }
  }
  function visibility() {
    if (document.visibilityState === 'hidden') beacon();
    else void flush();
  }
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  const push = function (...args) {
    originalPush.apply(this, args);
    navigation();
  };
  const replace = function (...args) {
    originalReplace.apply(this, args);
    navigation();
  };
  history.pushState = push;
  history.replaceState = replace;
  window.addEventListener('popstate', navigation);
  window.addEventListener('pagehide', beacon);
  document.addEventListener('visibilitychange', visibility);
  const heartbeat = setInterval(() => {
    if (document.visibilityState !== 'hidden') void flush();
  }, 30000);
  window.appHealth = {
    page,
    track,
    flush,
    diagnostics: () => ({ ...diagnostics, queued: queue.length + (pending?.events.length || 0) }),
    stop() {
      stopped = true;
      request?.abort();
      clearTimeout(timer);
      clearInterval(heartbeat);
      window.removeEventListener('popstate', navigation);
      window.removeEventListener('pagehide', beacon);
      document.removeEventListener('visibilitychange', visibility);
      if (history.pushState === push) history.pushState = originalPush;
      if (history.replaceState === replace) history.replaceState = originalReplace;
      queue.length = 0;
      pending = null;
      delete window.appHealth;
    },
  };
  page();
})();
