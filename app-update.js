(function (root) {
  'use strict';
  function createAppUpdateGuard({ canReload = () => false, window: win = root, document: doc = win.document } = {}) {
    const loadedAt = Date.parse(doc.lastModified);
    let candidate = 0, checking = false, pending = false, stopped = false, timer, lastCheck = 0;
    const storageKey = 'blockscope-app-reload-v1';
    const page = new URL(win.location.href);
    page.hash = '';
    const reload = () => {
      if (!pending || doc.hidden || !canReload()) return;
      try {
        if (win.sessionStorage.getItem(storageKey) === String(candidate)) return;
        win.sessionStorage.setItem(storageKey, String(candidate));
      } catch (_) { return; }
      const destination = new URL(win.location.href);
      destination.searchParams.delete('appCheck');
      destination.searchParams.set('appVersion', String(candidate));
      win.location.replace(destination.href);
    };
    async function check() {
      if (stopped || checking || doc.hidden || win.navigator.onLine === false || !Number.isFinite(loadedAt)) return;
      if (pending) { reload(); return; }
      if (lastCheck && Date.now() - lastCheck < (candidate ? 60000 : 600000)) return;
      checking = true;
      lastCheck = Date.now();
      try {
        const url = new URL(page);
        url.searchParams.set('appCheck', String(Math.floor(Date.now() / 600000)));
        const response = await win.fetch(url.href, { method: 'HEAD', cache: 'no-store', signal: win.AbortSignal.timeout(8000) });
        const modified = Date.parse(response.headers.get('Last-Modified'));
        if (!response.ok || !Number.isFinite(modified) || modified <= loadedAt || modified > Date.now() + 60000) return;
        if (candidate !== modified) { candidate = modified; return; }
        pending = true;
        reload();
      } catch (_) { /* A version check must never disrupt the current application. */ }
      finally { checking = false; }
    }
    const resume = () => { if (!doc.hidden) void check(); };
    doc.addEventListener('visibilitychange', resume);
    win.addEventListener('online', resume);
    // HEAD checks transfer no page body. Two observations prevent transient edge versions causing reload loops.
    timer = win.setInterval(check, 60000);
    const initial = win.setTimeout(check, 10000);
    return { check, stop() { stopped = true; win.clearInterval(timer); win.clearTimeout(initial);
      doc.removeEventListener('visibilitychange', resume); win.removeEventListener('online', resume); } };
  }
  root.createAppUpdateGuard = createAppUpdateGuard;
  if (typeof module !== 'undefined') module.exports = { createAppUpdateGuard };
})(typeof window === 'undefined' ? globalThis : window);
