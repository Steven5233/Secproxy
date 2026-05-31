/* ============================================================
   scanner.js — Passive security scanner
   Séç Proxy v2.0
   Runs automatically on every captured request/response pair.
   Flags issues in the DB and pushes alerts to the UI.
   ============================================================ */

'use strict';

/* ── Check definitions ───────────────────────────────────── */
const CHECKS = [

  /* ── Response header checks ── */
  {
    id:       'missing-hsts',
    severity: 'medium',
    type:     'Missing HSTS header',
    test({ scheme, resHeaders }) {
      return scheme === 'https' && !resHeaders['strict-transport-security'];
    },
    detail: 'Strict-Transport-Security header not present. The site is vulnerable to SSL stripping attacks.',
  },
  {
    id:       'missing-csp',
    severity: 'low',
    type:     'Missing Content-Security-Policy',
    test({ resHeaders }) {
      return !resHeaders['content-security-policy'] &&
             !resHeaders['x-content-security-policy'];
    },
    detail: 'No CSP header found. May be vulnerable to XSS attacks.',
  },
  {
    id:       'missing-xframe',
    severity: 'low',
    type:     'Missing X-Frame-Options',
    test({ resHeaders }) {
      return !resHeaders['x-frame-options'] &&
             !(resHeaders['content-security-policy'] || '').includes('frame-ancestors');
    },
    detail: 'No clickjacking protection header present.',
  },
  {
    id:       'missing-xcontent',
    severity: 'info',
    type:     'Missing X-Content-Type-Options',
    test({ resHeaders }) {
      return !resHeaders['x-content-type-options'];
    },
    detail: 'Browser may MIME-sniff content, bypassing declared content type.',
  },
  {
    id:       'server-disclosure',
    severity: 'info',
    type:     'Server version disclosed',
    test({ resHeaders }) {
      const s = resHeaders['server'] || '';
      return /[0-9]+\.[0-9]+/.test(s);
    },
    detail(ctx) {
      return `Server header reveals version: ${ctx.resHeaders['server']}`;
    },
  },
  {
    id:       'cors-wildcard',
    severity: 'medium',
    type:     'CORS wildcard (Access-Control-Allow-Origin: *)',
    test({ resHeaders }) {
      return resHeaders['access-control-allow-origin'] === '*';
    },
    detail: 'Wildcard CORS allows any origin to read this response.',
  },
  {
    id:       'cors-reflect',
    severity: 'high',
    type:     'CORS reflects arbitrary Origin',
    test({ reqHeaders, resHeaders }) {
      const origin = reqHeaders['origin'] || '';
      const acao   = resHeaders['access-control-allow-origin'] || '';
      const acac   = (resHeaders['access-control-allow-credentials'] || '').toLowerCase();
      return origin && acao === origin && acac === 'true';
    },
    detail: 'Server reflects the Origin header with credentials allowed — potential CORS misconfiguration.',
  },

  /* ── Cookie checks ── */
  {
    id:       'cookie-no-httponly',
    severity: 'low',
    type:     'Cookie missing HttpOnly flag',
    test({ resHeaders }) {
      const sc = resHeaders['set-cookie'] || '';
      if (!sc) return false;
      const cookies = Array.isArray(sc) ? sc : [sc];
      return cookies.some(c => !/httponly/i.test(c));
    },
    detail: 'One or more cookies are accessible to JavaScript.',
  },
  {
    id:       'cookie-no-secure',
    severity: 'low',
    type:     'Cookie missing Secure flag',
    test({ scheme, resHeaders }) {
      if (scheme !== 'https') return false;
      const sc = resHeaders['set-cookie'] || '';
      if (!sc) return false;
      const cookies = Array.isArray(sc) ? sc : [sc];
      return cookies.some(c => !/;\s*secure/i.test(c));
    },
    detail: 'One or more cookies can be sent over unencrypted HTTP.',
  },
  {
    id:       'cookie-no-samesite',
    severity: 'info',
    type:     'Cookie missing SameSite attribute',
    test({ resHeaders }) {
      const sc = resHeaders['set-cookie'] || '';
      if (!sc) return false;
      const cookies = Array.isArray(sc) ? sc : [sc];
      return cookies.some(c => !/samesite/i.test(c));
    },
    detail: 'Cookies without SameSite may be sent in cross-site requests (CSRF risk).',
  },

  /* ── Interesting response body / URL checks ── */
  {
    id:       'reflected-param',
    severity: 'info',
    type:     'Query param reflected in response',
    test({ url, resBody, resContentType }) {
      if (!resBody || !/html/i.test(resContentType || '')) return false;
      try {
        const parsed = new URL(url);
        for (const [, v] of parsed.searchParams) {
          if (v.length > 3 && resBody.includes(v)) return true;
        }
      } catch (_) {}
      return false;
    },
    detail: 'A query parameter value appears unescaped in the HTML response — potential XSS.',
  },
  {
    id:       'open-redirect',
    severity: 'medium',
    type:     'Possible open redirect',
    test({ resStatus, resHeaders, url }) {
      if (![301, 302, 303, 307, 308].includes(resStatus)) return false;
      const loc = resHeaders['location'] || '';
      if (!loc) return false;
      try {
        const dest = new URL(loc, url);
        const orig = new URL(url);
        return dest.hostname !== orig.hostname;
      } catch (_) { return false; }
    },
    detail(ctx) {
      return `Redirect to external host: ${ctx.resHeaders['location']}`;
    },
  },
  {
    id:       'basic-auth',
    severity: 'medium',
    type:     'HTTP Basic Authentication in use',
    test({ resStatus, resHeaders, scheme }) {
      return resStatus === 401 &&
             (resHeaders['www-authenticate'] || '').toLowerCase().startsWith('basic') &&
             scheme === 'http';
    },
    detail: 'Credentials sent as Basic Auth over plain HTTP are trivially sniffable.',
  },
  {
    id:       'jwt-in-url',
    severity: 'medium',
    type:     'JWT token in URL',
    test({ url }) {
      return /[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}/.test(url);
    },
    detail: 'JWTs in URLs are logged in server access logs and browser history.',
  },
  {
    id:       'stack-trace',
    severity: 'medium',
    type:     'Stack trace / debug info in response',
    test({ resBody }) {
      if (!resBody) return false;
      return /at\s+\w+\s*\(.*:\d+:\d+\)|Exception in thread|Traceback \(most recent|SyntaxError:|Fatal error:/
        .test(resBody);
    },
    detail: 'The server returned a stack trace, leaking internal paths and framework details.',
  },
  {
    id:       'private-ip',
    severity: 'info',
    type:     'Private IP address in response',
    test({ resBody }) {
      if (!resBody) return false;
      return /\b(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)\b/
        .test(resBody);
    },
    detail: 'A private RFC1918 IP address appears in the response body — possible SSRF target or network mapping.',
  },
];

/* ── Run all checks against a completed request entry ──── */
function scan(entry) {
  const ctx = {
    scheme:         entry.scheme || 'http',
    url:            entry.url    || '',
    resStatus:      entry.res_status,
    resBody:        entry.res_body || '',
    resContentType: '',
    reqHeaders:     {},
    resHeaders:     {},
  };

  try { ctx.reqHeaders = JSON.parse(entry.req_headers || '{}'); } catch (_) {}
  try { ctx.resHeaders = JSON.parse(entry.res_headers || '{}'); } catch (_) {}

  // Normalise header names to lowercase
  ctx.reqHeaders = toLower(ctx.reqHeaders);
  ctx.resHeaders = toLower(ctx.resHeaders);
  ctx.resContentType = ctx.resHeaders['content-type'] || '';

  const hits = [];
  for (const check of CHECKS) {
    try {
      if (check.test(ctx)) {
        hits.push({
          severity: check.severity,
          type:     check.type,
          detail:   typeof check.detail === 'function' ? check.detail(ctx) : check.detail,
        });
      }
    } catch (_) {}
  }
  return hits;
}

function toLower(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

module.exports = { scan };
