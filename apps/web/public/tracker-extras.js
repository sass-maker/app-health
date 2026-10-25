/** Resolve optional assets on the tracker host; only the explicit release token carries over. */
export function assetURL(script, filename) {
  try {
    const url = new URL(script.src);
    if (!/\/tracker\.js$/.test(url.pathname)) return undefined;
    url.pathname = url.pathname.replace(/tracker\.js$/, filename);
    const version = url.searchParams.get('v');
    url.search = '';
    url.hash = '';
    if (version && /^[a-zA-Z0-9._-]{1,64}$/.test(version)) url.searchParams.set('v', version);
    return url.href;
  } catch {
    return undefined;
  }
}

/** Optional automatic events collect destination hosts, known file types and coarse scroll milestones. */
export function start(tracker, script) {
  const enabled = (name) => ['', '1', 'true'].includes(script.dataset[name]);
  let stopped = false;
  let frame = 0;
  let depth = 0;
  let vitals;
  let control;
  function click(event) {
    if (stopped || event.defaultPrevented || event.button !== 0) return;
    const link = event.target?.closest?.('a[href]');
    if (!link) return;
    try {
      const url = new URL(link.href, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      const extension = url.pathname.match(/\.([a-z0-9]{1,10})$/i)?.[1].toLowerCase();
      const known = /^(pdf|zip|gz|tar|csv|xlsx?|docx?|pptx?|mp[34]|webm|wav|exe|dmg|apk)$/.test(
        extension || '',
      );
      if (link.hasAttribute('download') || known)
        tracker.track('file_download', {
          hostname: url.hostname,
          extension: known ? extension : 'other',
        });
      else if (url.origin !== location.origin)
        tracker.track('outbound_click', { hostname: url.hostname });
    } catch {
      // Invalid links and unsupported URL schemes never affect the host page.
    }
  }
  function reset() {
    depth = 0;
    window.cancelAnimationFrame(frame);
    frame = 0;
  }
  function measure() {
    frame = 0;
    if (stopped || document.visibilityState === 'hidden' || document.prerendering) return;
    const height = document.documentElement.scrollHeight - window.innerHeight;
    if (height <= 0) return;
    const percent = Math.min(100, Math.floor((Math.max(0, window.scrollY) / height) * 100));
    for (const threshold of [25, 50, 75, 100])
      if (depth < threshold && percent >= threshold)
        tracker.track('scroll_depth', { percent: threshold });
    depth = Math.max(depth, percent);
  }
  function scroll() {
    if (!frame) frame = window.requestAnimationFrame(measure);
  }
  if (enabled('autotrack')) document.addEventListener('click', click);
  if (enabled('404')) tracker.track('page_not_found');
  if (enabled('scroll')) {
    window.addEventListener('scroll', scroll, { passive: true });
  }
  const src = enabled('vitals') && assetURL(script, 'vitals.js');
  if (src) {
    const instance = crypto.randomUUID();
    control = {
      generation: instance,
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    window.appHealthVitals = control;
    vitals = document.createElement('script');
    vitals.defer = true;
    vitals.src = src;
    Object.assign(vitals.dataset, script.dataset);
    vitals.dataset.vitalsPath = location.pathname;
    vitals.dataset.vitalsGeneration = instance;
    document.head.appendChild(vitals);
  }
  const cleanup = () => {
    stopped = true;
    if (enabled('scroll')) reset();
    document.removeEventListener('click', click);
    window.removeEventListener('scroll', scroll);
    if (control) {
      control.stopped = true;
      // A stale instance must not stop a newer document measurement.
      if (window.appHealthVitals?.generation === control.generation) window.appHealthVitals.stop();
      vitals.remove();
    }
  };
  if (enabled('scroll')) cleanup.page = reset;
  return cleanup;
}
