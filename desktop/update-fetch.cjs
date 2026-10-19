'use strict';

// Electron net.fetch rejects manual redirects rather than returning a 302.
// Probe asset headers through ClientRequest, then stream the approved URL with
// fetch redirect:error. This keeps Chromium's proxy support and backpressure.
function createUpdateFetch(net) {
  return async (url, options = {}) => {
    const { signal } = options;
    signal?.throwIfAborted();
    if (url === 'https://api.github.com/repos/scytalezz/quadpane/releases/latest') {
      return net.fetch(url, { ...options, redirect: 'error' });
    }
    const redirect = await new Promise((resolve, reject) => {
      const request = net.request({ url, method: 'HEAD', redirect: 'manual',
        credentials: 'omit', useSessionCookies: false, headers: options.headers, cache: 'no-store' });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
        request.abort();
      };
      const abort = () => finish(signal.reason || new Error('Update request cancelled'));
      request.on('redirect', (status, _method, location) => {
        finish(null, { status, location });
      });
      request.on('response', response => {
        response.on('error', error => finish(error));
        finish(null, null);
      });
      request.on('error', error => finish(error));
      request.on('abort', () => { if (!settled) finish(new Error('Update request cancelled')); });
      request.on('login', (_info, callback) => callback());
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else request.end();
    });
    signal?.throwIfAborted();
    if (redirect) return new Response(null, { status: redirect.status, headers: { location: redirect.location } });
    return net.fetch(url, { ...options, redirect: 'error' });
  };
}

module.exports = { createUpdateFetch };
