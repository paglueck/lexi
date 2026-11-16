// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Dev proxy for `ng serve`.
 *
 * `.mjs` rather than `.json` because `configure()` is the escape hatch if SSE
 * through the proxy ever needs it, and JSON cannot express it.
 */
export default {
  '/api': {
    target: 'http://127.0.0.1:4317',
    // Required, not cosmetic: without it the proxy forwards `Host: localhost:4200`,
    // which the server's Host allowlist rejects. With it, Host becomes
    // 127.0.0.1:4317 while `Origin: http://localhost:4200` survives — exactly the
    // pair the dev-mode allowlist expects.
    changeOrigin: true,
    secure: false,
    ws: false,
    // An SSE stream is idle for the whole heartbeat interval. The defaults would
    // tear it down.
    timeout: 0,
    proxyTimeout: 0,
    configure(proxy) {
      proxy.on('proxyRes', (proxyRes, _req, res) => {
        if (String(proxyRes.headers['content-type']).startsWith('text/event-stream')) {
          // Registering ANY custom `proxyRes` listener here means we own the
          // response from this point on — the proxy's own default header copy
          // never runs once a listener is attached, so without this line
          // `res` reaches the browser with no `Content-Type` at all. A native
          // `EventSource` (unlike `fetch`) enforces the MIME type strictly and
          // aborts the connection outright on that: "MIME type ('text/plain')
          // is not 'text/event-stream'". `fetch`-based testing never catches
          // this, which is exactly how it shipped unnoticed.
          if (!res.headersSent) res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.flushHeaders?.();
        }
      });
    },
  },
};
