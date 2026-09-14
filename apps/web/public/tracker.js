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
  const scope = script.dataset.project || script.dataset.key;
  const sessionOnly = script.dataset.identity === 'session';
  const visitorKey = `h:${scope}:v`;
  const visitKey = `h:${scope}:w`;
  let storage;
  let visitor;
  let visit;
  let entered = ['reload', 'back_forward'].includes(
    globalThis.performance.getEntriesByType?.('navigation')[0]?.type,
  );
  let documentVisit;
  let recording;
  let waiting = 0;
  try {
    storage = sessionOnly ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    storage = undefined;
  }
  const uuid = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const diagnostics = { accepted: 0, dropped: 0, retries: 0 };

  function readStored(key) {
    try {
      return JSON.parse(storage?.getItem(key) || 'null');
    } catch {
      storage = undefined;
      return null;
    }
  }
  function writeStored(key, value) {
    if (!storage) return false;
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      storage = undefined;
      return false;
    }
  }
  function attribution(path) {
    const url = new URL(path || location.href, location.href);
    const value = (name) =>
      String(
        (!entered && (url.searchParams.get(`utm_${name}`) || (name === 'source' && referrer()))) ||
          '',
      )
        .replace(/[^a-zA-Z0-9 _.,:+/-]/g, '')
        .slice(0, 100);
    return {
      ...Object.fromEntries(
        ['source', 'medium', 'campaign', 'content', 'term'].map((name) => [name, value(name)]),
      ),
      entry_path: safePath(url.pathname),
    };
  }

  function recognizedVisitor(now) {
    if (sessionOnly || !storage) return undefined;
    const saved = readStored(visitorKey);
    if (!storage) return undefined;
    if (saved && uuid(saved.id) && saved.expires > now) {
      visitor = saved;
      return false;
    }
    visitor = { id: crypto.randomUUID(), expires: now + 90 * 86400000 };
    return writeStored(visitorKey, visitor) ? true : undefined;
  }
  function validVisit(value) {
    return (
      value &&
      uuid(value.id) &&
      Number.isFinite(value.last) &&
      value.attribution &&
      typeof value.attribution.entry_path === 'string'
    );
  }
  function visitContext(meaningful = false, path = location.href) {
    const now = Date.now();
    const saved = readStored(visitKey);
    if (validVisit(saved)) visit = saved;
    if (!meaningful)
      return validVisit(visit) && now >= visit.last && now - visit.last < 1800000
        ? contextOf(visit)
        : null;
    const freshVisitor = recognizedVisitor(now);
    const visitorId = freshVisitor === undefined ? undefined : visitor.id;
    if (
      !validVisit(visit) ||
      visit.visitor_id !== visitorId ||
      now - visit.last >= 1800000 ||
      now < visit.last
    ) {
      visit = {
        id: crypto.randomUUID(),
        last: now,
        visitor_id: visitorId,
        type: visitorId ? (freshVisitor ? 'new' : 'returning') : undefined,
        attribution: attribution(path),
      };
    }
    entered = true;
    visit = { ...visit, last: now };
    if (storage && !writeStored(visitKey, visit)) {
      visit = { ...visit, visitor_id: undefined, type: undefined };
    }
    return contextOf(visit);
  }
  function contextOf(value) {
    return {
      session_id: value.id,
      ...(value.visitor_id ? { visitor_id: value.visitor_id, visit_type: value.type } : {}),
      attribution: value.attribution,
    };
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
    if (
      pending &&
      !pending.events.length &&
      pending.context.session_id !== visitContext()?.session_id
    )
      pending = null;
    if (!pending) {
      const context = queue[0]?.context || visitContext();
      if (!context) return null;
      const events = [];
      while (events.length < 25 && queue[0]?.context.session_id === context.session_id) {
        const { context: _context, ...event } = queue.shift();
        events.push(event);
      }
      pending = { attempts: 0, events, batch_id: crypto.randomUUID(), context };
    }
    return JSON.stringify({
      schema_version: 1,
      public_key: script.dataset.key,
      batch_id: pending.batch_id,
      ...pending.context,
      events: pending.events,
    });
  }

  async function flush() {
    if (waiting) await recording;
    if (stopped || sending || document.visibilityState === 'hidden') return;
    clearTimeout(timer);
    timer = null;
    const body = payload();
    if (!body) return;
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

  function emit(...args) {
    if (stopped || waiting + queue.length >= 100) {
      diagnostics.dropped++;
      return;
    }
    if (!storage || sessionOnly || !navigator.locks) return record(...args);
    waiting++;
    recording = navigator.locks
      .request(visitKey, () => record(...args))
      .catch(() => {
        storage = undefined;
        record(...args);
      })
      .finally(() => {
        waiting--;
      });
  }
  function record(type, name, path) {
    if (stopped) return;
    const context = visitContext(true, path);
    documentVisit ||= context.session_id;
    queue.push({
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      context,
      type,
      path: safePath(path),
      referrer: context.session_id === documentVisit ? referrer() : '',
      ...(name ? { name } : {}),
    });
    schedule();
  }
  function page(path = location.href) {
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
  function restore({ persisted }) {
    if (persisted) page();
  }
  async function beacon() {
    if (waiting) await recording;
    if (pending || queue.length) {
      try {
        const body = payload();
        if (body) navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }));
      } catch {
        return;
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
  window.addEventListener('pageshow', restore);
  document.addEventListener('visibilitychange', visibility);
  const heartbeat = setInterval(() => {
    if (document.visibilityState !== 'hidden') void flush();
  }, 30000);
  window.appHealth = {
    page,
    track,
    flush,
    diagnostics: () => ({
      ...diagnostics,
      queued: waiting + queue.length + (pending?.events.length || 0),
    }),
    stop() {
      stopped = true;
      request?.abort();
      clearTimeout(timer);
      clearInterval(heartbeat);
      window.removeEventListener('popstate', navigation);
      window.removeEventListener('pagehide', beacon);
      window.removeEventListener('pageshow', restore);
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
