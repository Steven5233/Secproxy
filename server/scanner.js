/* ============================================================
   server/scanner.js — Passive security scanner
   Séç Proxy v2.0
   Runs on every completed request/response pair.
   ============================================================ */
'use strict';

const CHECKS = [
  // ── Response headers ──────────────────────────────────────
  {
    id:'missing-hsts', severity:'medium', type:'Missing HSTS',
    test({scheme,rH}){ return scheme==='https' && !rH['strict-transport-security']; },
    detail:'Strict-Transport-Security header absent — vulnerable to SSL stripping.',
  },
  {
    id:'missing-csp', severity:'low', type:'Missing Content-Security-Policy',
    test({rH}){ return !rH['content-security-policy'] && !rH['x-content-security-policy']; },
    detail:'No CSP header. May be vulnerable to XSS.',
  },
  {
    id:'missing-xframe', severity:'low', type:'Missing X-Frame-Options',
    test({rH}){ return !rH['x-frame-options'] && !(rH['content-security-policy']||'').includes('frame-ancestors'); },
    detail:'No clickjacking protection.',
  },
  {
    id:'missing-xcto', severity:'info', type:'Missing X-Content-Type-Options',
    test({rH}){ return !rH['x-content-type-options']; },
    detail:'Browser may MIME-sniff responses.',
  },
  {
    id:'server-version', severity:'info', type:'Server version disclosed',
    test({rH}){ return /\d+\.\d+/.test(rH['server']||''); },
    detail(ctx){ return `Server header: ${ctx.rH['server']}`; },
  },
  {
    id:'cors-wildcard', severity:'medium', type:'CORS wildcard (*)',
    test({rH}){ return rH['access-control-allow-origin']==='*'; },
    detail:'Any origin can read this response.',
  },
  {
    id:'cors-reflect', severity:'high', type:'CORS reflects Origin with credentials',
    test({qH,rH}){
      const o = qH['origin']||'';
      return o && rH['access-control-allow-origin']===o &&
             (rH['access-control-allow-credentials']||'').toLowerCase()==='true';
    },
    detail:'Server reflects Origin header with credentials=true — CORS misconfiguration.',
  },
  // ── Cookies ───────────────────────────────────────────────
  {
    id:'cookie-httponly', severity:'low', type:'Cookie missing HttpOnly',
    test({rH}){
      const c=rH['set-cookie']; if(!c) return false;
      return (Array.isArray(c)?c:[c]).some(x=>/httponly/i.test(x)===false);
    },
    detail:'Cookie accessible to JavaScript — XSS can steal it.',
  },
  {
    id:'cookie-secure', severity:'low', type:'Cookie missing Secure flag',
    test({scheme,rH}){
      if(scheme!=='https') return false;
      const c=rH['set-cookie']; if(!c) return false;
      return (Array.isArray(c)?c:[c]).some(x=>/;\s*secure/i.test(x)===false);
    },
    detail:'Cookie sent over plain HTTP.',
  },
  {
    id:'cookie-samesite', severity:'info', type:'Cookie missing SameSite',
    test({rH}){
      const c=rH['set-cookie']; if(!c) return false;
      return (Array.isArray(c)?c:[c]).some(x=>/samesite/i.test(x)===false);
    },
    detail:'Cookie vulnerable to CSRF.',
  },
  // ── Response body ─────────────────────────────────────────
  {
    id:'reflected-param', severity:'info', type:'Query param reflected in HTML',
    test({url,resBody,ctype}){
      if(!resBody||!/html/i.test(ctype||'')) return false;
      try {
        const p=new URL(url);
        for(const[,v] of p.searchParams){ if(v.length>3 && resBody.includes(v)) return true; }
      } catch(_){}
      return false;
    },
    detail:'A query param appears unescaped in HTML — potential XSS.',
  },
  {
    id:'open-redirect', severity:'medium', type:'Possible open redirect',
    test({status,rH,url}){
      if(![301,302,303,307,308].includes(status)) return false;
      const loc=rH['location']||'';
      try{ const d=new URL(loc,url),o=new URL(url); return d.hostname!==o.hostname; } catch(_){ return false; }
    },
    detail(ctx){ return `Redirects to external host: ${ctx.rH['location']}`; },
  },
  {
    id:'stack-trace', severity:'medium', type:'Stack trace in response',
    test({resBody}){
      return resBody && /at\s+\w+\s*\(.*:\d+:\d+\)|Traceback \(most recent|Exception in thread|Fatal error:/
        .test(resBody);
    },
    detail:'Server leaked internal paths/framework via stack trace.',
  },
  {
    id:'private-ip', severity:'info', type:'Private IP in response',
    test({resBody}){
      return resBody && /\b(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)\b/
        .test(resBody);
    },
    detail:'RFC1918 IP found — possible SSRF target.',
  },
  {
    id:'jwt-in-url', severity:'medium', type:'JWT in URL',
    test({url}){ return /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(url); },
    detail:'JWTs in URLs appear in logs and browser history.',
  },
  {
    id:'basic-auth-plain', severity:'high', type:'Basic Auth over HTTP',
    test({scheme,status,rH}){
      return scheme==='http' && status===401 &&
             (rH['www-authenticate']||'').toLowerCase().startsWith('basic');
    },
    detail:'Credentials transmitted in plaintext.',
  },
];

// lowercase all header keys
function toLower(obj) {
  const out={};
  for (const k of Object.keys(obj||{})) out[k.toLowerCase()]=obj[k];
  return out;
}

function scan(entry) {
  let qH={}, rH={};
  try { qH=toLower(JSON.parse(entry.req_headers||'{}')); } catch(_){}
  try { rH=toLower(JSON.parse(entry.res_headers||'{}')); } catch(_){}

  const ctx = {
    scheme:  entry.scheme||'http',
    url:     entry.url||'',
    status:  entry.res_status,
    resBody: entry.res_body||'',
    ctype:   rH['content-type']||'',
    qH, rH,
  };

  const hits=[];
  for (const c of CHECKS) {
    try {
      if (c.test(ctx)) hits.push({
        severity: c.severity,
        type:     c.type,
        detail:   typeof c.detail==='function' ? c.detail(ctx) : c.detail,
      });
    } catch(_){}
  }
  return hits;
}

module.exports = { scan };
