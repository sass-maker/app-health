(() => {
  const script = document.currentScript;
  if (!script || window.appHealth || !script.dataset.key?.startsWith('ahk_pub_')) return;
  const endpoint = script.dataset.endpoint || 'https://ingest.sassmaker.com/v1/browser';
  const queue = [];
  let pending = null;
  let delivery;
  let request;
  let timer;
  let stopped = false;
  let lastPath = '';
  let stopExtras;
  let stopHooks;
  const hash = ['', '1', 'true'].includes(script.dataset.hash);
  const scope = script.dataset.project || script.dataset.key;
  const sessionOnly = script.dataset.identity === 'session';
  const cookieless = script.dataset.identity === 'cookieless';
  let consented =
    script.dataset.consent !== 'required' && script.dataset.identity !== 'until-consent';
  const ignoreKey = `h:${scope}:ignore`;
  let ignored = readIgnored();
  let generation = 0;
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
  function enabled() {
    return !stopped && consented && !ignored;
  }
  function readIgnored() {
    try {
      return globalThis.localStorage?.getItem(ignoreKey) === '1';
    } catch {
      return false;
    }
  }
  function initializeStorage() {
    if (!enabled() || cookieless) return;
    try {
      storage = sessionOnly ? globalThis.sessionStorage : globalThis.localStorage;
    } catch {
      storage = undefined;
    }
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
        (!entered &&
          (url.searchParams.get(`utm_${name}`) ||
            (name === 'source' &&
              (referralTag(url, 'ref') || referralTag(url, 'via') || referrer())))) ||
          '',
      )
        .replace(/[^a-zA-Z0-9 _.,:+/-]/g, '')
        .slice(0, 100);
    return {
      ...Object.fromEntries(
        ['source', 'medium', 'campaign', 'content', 'term'].map((name) => [name, value(name)]),
      ),
      entry_path: safePath(url.href),
    };
  }

  function referralTag(url, name) {
    const value = url.searchParams.get(name) || '';
    return /^[a-zA-Z0-9 _.,+-]{1,100}$/.test(value) ? value : '';
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
  function visitContext(meaningful, path = location.href) {
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
      const url = new URL(value, location.href);
      const path =
        hash && /^#!?\//.test(url.hash)
          ? url.hash.replace(/^#!?/, '').split(/[?#]/)[0]
          : url.pathname;
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
    if (enabled() && !timer && document.visibilityState !== 'hidden')
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
      const batch_id = crypto.randomUUID();
      while (events.length < 25 && queue[0]?.context.session_id === context.session_id) {
        const { context: _context, ...event } = queue[0];
        const candidate = JSON.stringify({
          schema_version: 1,
          public_key: script.dataset.key,
          batch_id,
          ...context,
          events: [...events, event],
        });
        if (new Blob([candidate]).size > 32768) {
          if (events.length) break;
          queue.shift();
          diagnostics.dropped++;
          continue;
        }
        queue.shift();
        events.push(event);
      }
      pending = { attempts: 0, events, batch_id, context };
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
    if (!enabled() || document.visibilityState === 'hidden') return;
    if (delivery) {
      await delivery.catch(() => {});
      if (queue.length) return flush();
      return;
    }
    clearTimeout(timer);
    timer = null;
    const body = payload();
    if (!body) return;
    const attempt = pending;
    const version = generation;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      delivery = fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        credentials: 'omit',
        body,
        keepalive: true,
        signal: controller.signal,
      });
      const response = await delivery;
      if (version !== generation) return;
      if (!response.ok && (response.status === 429 || response.status >= 500)) throw new Error();
      if (response.ok) diagnostics.accepted += attempt.events.length;
      else diagnostics.dropped += attempt.events.length;
      pending = null;
    } catch {
      if (version !== generation) return;
      attempt.attempts++;
      diagnostics.retries++;
      if (attempt.attempts >= 3) {
        diagnostics.dropped += attempt.events.length;
        pending = null;
      }
    } finally {
      clearTimeout(timeout);
      request = null;
      delivery = null;
      if (pending || queue.length) schedule(1500 * Math.pow(2, attempt.attempts));
    }
  }

  function emit(...args) {
    if (!enabled() || waiting + queue.length >= 100) {
      diagnostics.dropped++;
      return;
    }
    if (!storage || sessionOnly || !navigator.locks) return record(...args);
    const version = generation;
    waiting++;
    recording = navigator.locks
      .request(visitKey, () => {
        if (version === generation) record(...args);
      })
      .catch(() => {
        if (version === generation) {
          storage = undefined;
          record(...args);
        }
      })
      .finally(() => {
        if (version === generation) waiting--;
      });
  }
  function record(type, name, path, properties, value) {
    if (!enabled()) return;
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
      ...(properties === undefined ? {} : { properties }),
      ...(value === undefined ? {} : { value }),
    });
    schedule();
  }
  function page(path = location.href) {
    lastPath = navigationPath();
    emit('pageview', undefined, path);
    stopExtras?.page?.();
  }
  function track(name, properties, value) {
    if (
      (value !== undefined && (!Number.isFinite(value) || Math.abs(value) > 1e12)) ||
      (properties !== undefined &&
        (!properties ||
          typeof properties !== 'object' ||
          Array.isArray(properties) ||
          Object.entries(properties).length > 20 ||
          Object.entries(properties).some(
            ([key, item]) =>
              !/^[a-z][a-z0-9_]{0,39}$/.test(key) ||
              ['constructor', 'prototype'].includes(key) ||
              !(
                typeof item === 'boolean' ||
                (typeof item === 'string' && item.length <= 200) ||
                (Number.isFinite(item) && Math.abs(item) <= 1e12)
              ),
          )))
    ) {
      diagnostics.dropped++;
      return;
    }
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(name)) {
      diagnostics.dropped++;
      return;
    }
    emit('event', name, location.href, properties && { ...properties }, value);
  }
  function navigation() {
    if (navigationPath() !== lastPath) page();
  }
  function navigationPath() {
    return location.pathname + (hash ? location.hash.split(/[?]/)[0] : '');
  }
  function restore({ persisted }) {
    if (persisted) page();
  }
  async function beacon() {
    if (waiting) await recording;
    if (enabled() && (pending || queue.length)) {
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
  function pause() {
    generation++;
    request?.abort();
    clearTimeout(timer);
    timer = null;
    stopExtras?.();
    stopExtras = undefined;
    stopHooks?.();
    stopHooks = undefined;
    queue.length = 0;
    pending = null;
    waiting = 0;
    recording = undefined;
    visit = visitor = storage = documentVisit = undefined;
  }
  function resume() {
    if (!enabled()) return;
    initializeStorage();
    stopHooks = hooks();
    loadExtras();
    page();
  }
  function exclusion(value) {
    if (ignored === value) return;
    ignored = value;
    pause();
    resume();
  }
  function preference(event) {
    if (event.key === ignoreKey || event.key === null) exclusion(readIgnored());
  }
  function checkoutMetadata() {
    const tags = enabled() && (visitContext()?.attribution || attribution());
    if (!tags) return {};
    const result = { app_health_page: safePath(tags.entry_path) };
    for (const name of ['source', 'campaign'])
      if (/^[a-zA-Z0-9 _.,:+/-]{1,100}$/.test(tags[name] || ''))
        result[`app_health_${name}`] = tags[name];
    return result;
  }
  function hooks() {
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
    if (hash) window.addEventListener('hashchange', navigation);
    window.addEventListener('pagehide', beacon);
    window.addEventListener('pageshow', restore);
    document.addEventListener('visibilitychange', visibility);
    const heartbeat = setInterval(() => {
      if (document.visibilityState !== 'hidden') void flush();
    }, 30000);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener('popstate', navigation);
      window.removeEventListener('hashchange', navigation);
      window.removeEventListener('pagehide', beacon);
      window.removeEventListener('pageshow', restore);
      document.removeEventListener('visibilitychange', visibility);
      if (history.pushState === push) history.pushState = originalPush;
      if (history.replaceState === replace) history.replaceState = originalReplace;
    };
  }
  window.addEventListener('storage', preference);
  window.appHealth = {
    page,
    track,
    flush,
    checkoutMetadata,
    consent(value) {
      value = value === true;
      if (stopped || consented === value) return;
      consented = value;
      pause();
      resume();
    },
    ignore(value = true) {
      if (stopped || typeof value !== 'boolean') return;
      // This preference is the sole storage access permitted before consent.
      try {
        if (value) globalThis.localStorage?.setItem(ignoreKey, '1');
        else globalThis.localStorage?.removeItem(ignoreKey);
      } catch {
        /* The preference still applies in this document. */
      }
      exclusion(value);
    },
    isIgnored: () => ignored,
    diagnostics: () => ({
      ...diagnostics,
      queued: waiting + queue.length + (pending?.events.length || 0),
    }),
    stop() {
      stopped = true;
      pause();
      window.removeEventListener('storage', preference);
      delete window.appHealth;
    },
  };
  function loadExtras() {
    if (
      !enabled() ||
      !['vitals', 'autotrack', '404', 'scroll'].some((key) =>
        ['', '1', 'true'].includes(script.dataset[key]),
      )
    )
      return;
    const url = new URL(script.src || location.href);
    if (!/\/tracker\.js$/.test(url.pathname)) return;
    url.pathname = url.pathname.replace(/tracker\.js$/, 'tracker-extras.js');
    url.hash = '';
    const version = url.searchParams.get('v');
    url.search = /^[a-zA-Z0-9._-]{1,64}$/.test(version || '') ? '?v=' + version : '';
    const active = generation;
    void import(url.href)
      .then(({ start }) => {
        if (enabled() && active === generation) stopExtras = start(window.appHealth, script);
      })
      .catch(() => {});
  }
  resume();
})();
