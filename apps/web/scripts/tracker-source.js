(() => {
  const script = document.currentScript;
  if (!script || window.appHealth || !script.dataset.key?.startsWith('ahk_pub_')) return;
  const endpoint = script.dataset.endpoint || 'https://ingest.sassmaker.com/v1/browser';
  const queue = [];
  const handoffs = [];
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
  const migratedKey = `h:${scope}:m`;
  let storage;
  let visit;
  let database;
  let connection;
  let cancelOpen;
  const transactions = new Map();
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
      if (!sessionOnly) {
        storage?.getItem(visitorKey);
        storage?.setItem(migratedKey, storage.getItem(migratedKey) === '1' ? '1' : '0');
      }
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
  function readLegacy(key) {
    const value = storage.getItem(key);
    try {
      return JSON.parse(value || 'null');
    } catch {
      return null;
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
    const saved = sessionOnly && readStored(visitKey);
    if (validVisit(saved)) visit = saved;
    if (!meaningful)
      return validVisit(visit) && now >= visit.last && now - visit.last < 1800000
        ? contextOf(visit)
        : null;
    if (!validVisit(visit) || now - visit.last >= 1800000 || now < visit.last) {
      visit = {
        id: crypto.randomUUID(),
        last: now,
        attribution: attribution(path),
      };
    }
    entered = true;
    visit = { ...visit, last: now };
    if (sessionOnly && storage && !writeStored(visitKey, visit)) {
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

  function openIdentity(version) {
    database ||= new Promise((resolve, reject) => {
      let settled = false;
      const fail = () => {
        settled = true;
        clearTimeout(timeout);
        if (cancelOpen === fail) cancelOpen = undefined;
        reject(new Error('Identity storage unavailable'));
      };
      const timeout = setTimeout(fail, 2000);
      cancelOpen = fail;
      try {
        const opening = globalThis.indexedDB.open('app-health-identity', 1);
        opening.onupgradeneeded = () => {
          if (!enabled() || generation !== version || settled) opening.transaction.abort();
          else opening.result.createObjectStore('scopes');
        };
        opening.onerror = opening.onblocked = fail;
        opening.onsuccess = () => {
          clearTimeout(timeout);
          if (settled || !enabled() || generation !== version) {
            opening.result.close();
            fail();
            return;
          }
          settled = true;
          if (cancelOpen === fail) cancelOpen = undefined;
          const db = opening.result;
          connection = db;
          db.onversionchange = () => db.close();
          resolve(db);
        };
      } catch {
        fail();
      }
    });
    return database;
  }
  function persistentIdentity(meaningful, path, version) {
    return openIdentity(version).then(
      (db) =>
        new Promise((resolve, reject) => {
          if (!enabled() || generation !== version) return reject(new Error('Identity cancelled'));
          const transaction = db.transaction('scopes', 'readwrite');
          const timeout = setTimeout(cancel, 2000);
          let candidate;
          const finish = () => {
            clearTimeout(timeout);
            transactions.delete(transaction);
          };
          function cancel() {
            finish();
            try {
              transaction.abort();
            } catch {
              /* The transaction already finished. */
            }
          }
          transactions.set(transaction, cancel);
          transaction.onabort = transaction.onerror = () => {
            finish();
            reject(new Error('Identity transaction failed'));
          };
          transaction.oncomplete = () => {
            finish();
            if (!enabled() || generation !== version)
              return reject(new Error('Identity cancelled'));
            if (meaningful && candidate) {
              try {
                storage.setItem(migratedKey, '1');
                storage.setItem(visitorKey, JSON.stringify(candidate.visitor));
                storage.setItem(visitKey, JSON.stringify(candidate.visit));
              } catch {
                /* The canonical record committed; retry the old-tab mirror on the next action. */
              }
            }
            resolve(candidate);
          };
          const store = transaction.objectStore('scopes');
          const reading = store.get(scope);
          reading.onsuccess = () => {
            try {
              if (!enabled() || generation !== version) return cancel();
              const now = Date.now();
              let saved = reading.result;
              if (!saved && !meaningful) return;
              if (!saved)
                saved =
                  storage.getItem(migratedKey) !== '1'
                    ? { visitor: readLegacy(visitorKey), visit: readLegacy(visitKey) }
                    : {};
              const previousVisitor = saved.visitor;
              const known =
                previousVisitor &&
                uuid(previousVisitor.id) &&
                Number.isFinite(previousVisitor.expires) &&
                previousVisitor.expires > now;
              const visitor = known
                ? { id: previousVisitor.id, expires: previousVisitor.expires }
                : { id: crypto.randomUUID(), expires: now + 90 * 86400000 };
              let current = saved.visit;
              if (meaningful && known && validVisit(current)) {
                const legacy = readLegacy(visitKey);
                if (
                  legacy?.id === current.id &&
                  legacy.visitor_id === visitor.id &&
                  Number.isFinite(legacy.last) &&
                  legacy.last > current.last &&
                  legacy.last <= now &&
                  now - legacy.last < 1800000
                )
                  current = { ...current, last: legacy.last };
              }
              if (
                !validVisit(current) ||
                !['new', 'returning'].includes(current.type) ||
                current.visitor_id !== visitor.id ||
                now - current.last >= 1800000 ||
                now < current.last
              ) {
                current = meaningful
                  ? {
                      id: crypto.randomUUID(),
                      last: now,
                      visitor_id: visitor.id,
                      type: known ? 'returning' : 'new',
                      attribution: attribution(path),
                    }
                  : null;
              }
              if (!current) return;
              current = {
                id: current.id,
                last: current.last,
                visitor_id: visitor.id,
                type: current.type,
                attribution: {
                  ...Object.fromEntries(
                    ['source', 'medium', 'campaign', 'content', 'term'].map((name) => [
                      name,
                      String(current.attribution[name] || '')
                        .replace(/[^a-zA-Z0-9 _.,:+/-]/g, '')
                        .slice(0, 100),
                    ]),
                  ),
                  entry_path: safePath(current.attribution.entry_path),
                },
              };
              candidate = { visitor, visit: meaningful ? { ...current, last: now } : current };
              if (meaningful) store.put(candidate, scope);
            } catch {
              cancel();
            }
          };
        }),
    );
  }
  function forgetPersistentIdentity() {
    if (!storage) return;
    storage = undefined;
    visit = validVisit(visit)
      ? { id: visit.id, last: visit.last, attribution: visit.attribution }
      : undefined;
    cancelOpen?.();
    for (const cancel of transactions.values()) cancel();
    connection?.close();
    connection = database = undefined;
  }
  async function refreshIdentity() {
    if (!storage || sessionOnly || queue.length || pending || handoffs.length) return;
    const version = generation;
    try {
      const saved = await persistentIdentity(false, undefined, version);
      if (generation === version && enabled() && storage) visit = saved?.visit;
    } catch {
      if (generation === version) forgetPersistentIdentity();
    }
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

  function batch() {
    const context = queue[0]?.context || visitContext();
    if (!context) return null;
    const events = [];
    const batch_id = crypto.randomUUID();
    while (events.length < 25 && queue[0]?.context.session_id === context.session_id) {
      const { context: _context, ...event } = queue[0];
      const candidate = body({ batch_id, context, events: [...events, event] });
      if (new Blob([candidate]).size > 32768) {
        if (events.length) break;
        queue.shift();
        diagnostics.dropped++;
        continue;
      }
      queue.shift();
      events.push(event);
    }
    return { attempts: 0, events, batch_id, context };
  }

  function body(batch) {
    return JSON.stringify({
      schema_version: 1,
      public_key: script.dataset.key,
      batch_id: batch.batch_id,
      ...batch.context,
      events: batch.events,
    });
  }

  function payload() {
    if (
      pending &&
      !pending.events.length &&
      pending.context.session_id !== visitContext()?.session_id
    )
      pending = null;
    pending ||= handoffs.shift() || batch();
    return pending ? body(pending) : null;
  }

  async function flush() {
    if (waiting) await recording;
    if (storage && !sessionOnly) await refreshIdentity();
    if (waiting) await recording;
    if (!enabled() || document.visibilityState === 'hidden') return;
    if (delivery) {
      await delivery.catch(() => {});
      if (queue.length || handoffs.length) return flush();
      return;
    }
    clearTimeout(timer);
    timer = null;
    const body = payload();
    if (!body) return;
    const attempt = pending;
    attempt.handedOff = false;
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
      if (pending || queue.length || handoffs.length)
        schedule(1500 * Math.pow(2, attempt.attempts));
    }
  }

  function emit(...args) {
    if (
      !enabled() ||
      waiting + queue.length + handoffs.reduce((sum, item) => sum + item.events.length, 0) >= 100
    ) {
      diagnostics.dropped++;
      return;
    }
    const timestamp = Date.now();
    if (!storage || sessionOnly) return record(args, undefined, timestamp);
    const version = generation;
    waiting++;
    recording = (recording || Promise.resolve())
      .then(async () => {
        if (version !== generation || !enabled()) return;
        if (!storage) return record(args, undefined, timestamp);
        const saved = await persistentIdentity(true, args[2], version);
        if (version !== generation || !enabled()) return;
        if (!storage) return record(args, undefined, timestamp);
        visit = saved.visit;
        entered = true;
        record(args, contextOf(visit), timestamp);
      })
      .catch(() => {
        if (version === generation) {
          forgetPersistentIdentity();
          record(args, undefined, timestamp);
        }
      })
      .finally(() => {
        if (version === generation) waiting--;
      });
  }
  function record(
    [type, name, path, properties, value],
    context = visitContext(true, path),
    timestamp = Date.now(),
  ) {
    if (!enabled()) return;
    documentVisit ||= context.session_id;
    queue.push({
      event_id: crypto.randomUUID(),
      timestamp,
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
    if (storage && !sessionOnly) await refreshIdentity();
    if (waiting) await recording;
    if (!enabled()) return true;
    const send = (item) => {
      if (item.handedOff) return true;
      item.handedOff = navigator.sendBeacon(
        endpoint,
        new Blob([body(item)], { type: 'text/plain' }),
      );
      return item.handedOff;
    };
    try {
      // The active fetch already owns a keepalive request. Send new actions
      // separately, retaining their immutable IDs until an acknowledged retry.
      if (pending && !delivery && payload() && !send(pending)) return false;
      for (const item of handoffs) if (!send(item)) return false;
      while (queue.length) {
        const item = batch();
        if (!item) break;
        handoffs.push(item);
        if (!send(item)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  function visibility() {
    if (document.visibilityState === 'hidden') beacon();
    else void flush();
  }
  function pause() {
    generation++;
    cancelOpen?.();
    for (const cancel of transactions.values()) cancel();
    transactions.clear();
    connection?.close();
    connection = database = undefined;
    request?.abort();
    clearTimeout(timer);
    timer = null;
    stopExtras?.();
    stopExtras = undefined;
    stopHooks?.();
    stopHooks = undefined;
    queue.length = 0;
    handoffs.length = 0;
    pending = null;
    waiting = 0;
    recording = undefined;
    visit = storage = documentVisit = undefined;
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
    flushForNavigation: beacon,
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
      queued:
        waiting +
        queue.length +
        (pending?.events.length || 0) +
        handoffs.reduce((sum, item) => sum + item.events.length, 0),
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
