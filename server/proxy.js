/* ============================================================
   server/proxy.js — Main proxy server + REST API
   Séç Proxy v2.0

   Ports:
     PROXY_PORT (default 8080) — HTTP forward proxy + REST API
     WS_PORT    (default 8081) — WebSocket bridge to UI
   ============================================================ */
'use strict';

const http      = require('http');
const https     = require('https');
const zlib      = require('zlib');
const fs        = require('fs');
const os        = require('os');

const db        = require('./db');
const bridge    = require('./ws-bridge');
const intercept = require('./intercept');
const mitm      = require('./mitm');
const scanner   = require('./scanner');
const ca        = require('./ca');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const WS_PORT    = parseInt(process.env.WS_PORT    || '8081', 10);

const stats = { total:0, intercepted:0, errors:0, bytesIn:0, bytesOut:0, startedAt:Date.now() };

// ── Helpers ──────────────────────────────────────────────────
function decompress(buf, enc) {
  return new Promise(res => {
    if (!enc) return res(buf);
    const e = enc.toLowerCase();
    if (e.includes('gzip'))    zlib.gunzip(buf, (er,r) => res(er?buf:r));
    else if (e.includes('deflate')) zlib.inflate(buf, (er,r) => res(er?buf:r));
    else if (e.includes('br')) zlib.brotliDecompress(buf, (er,r) => res(er?buf:r));
    else res(buf);
  });
}

function collectBody(req) {
  return new Promise(res => {
    const c=[];
    req.on('data', d => c.push(d));
    req.on('end',  () => res(Buffer.concat(c)));
    req.on('error',() => res(Buffer.alloc(0)));
  });
}

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets))
    for (const i of ifaces)
      if (i.family==='IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

function corsHeaders() {
  return {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'*',
    'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
  };
}

function sendJSON(res, data, status=200) {
  res.writeHead(status, corsHeaders());
  res.end(JSON.stringify(data));
}

// ── Forward a plain HTTP request to origin ───────────────────
function forwardHTTP(reqObj, clientRes) {
  return new Promise(resolve => {
    const parsed  = new URL(reqObj.url);
    const isHTTPS = parsed.protocol === 'https:';
    const lib     = isHTTPS ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHTTPS?443:80),
      path:     (parsed.pathname || '/') + (parsed.search || ''),
      method:   reqObj.method,
      headers:  { ...reqObj.headers },
      rejectUnauthorized: false,
    };
    delete opts.headers['proxy-connection'];
    delete opts.headers['proxy-authorization'];

    const t0  = Date.now();
    const req = lib.request(opts, async (originRes) => {
      const chunks=[];
      originRes.on('data', c => chunks.push(c));
      originRes.on('end',  async () => {
        const raw   = Buffer.concat(chunks);
        const buf   = await decompress(raw, originRes.headers['content-encoding']);
        const body  = buf.toString('utf8');
        const rh    = {};
        for (const [k,v] of Object.entries(originRes.headers)) rh[k]=v;
        delete rh['content-encoding'];
        rh['content-length'] = String(buf.length);

        // stream to client
        try { clientRes.writeHead(originRes.statusCode, rh); clientRes.end(buf); } catch(_){}

        resolve({ status:originRes.statusCode, headers:rh, body, latency_ms:Date.now()-t0 });
      });
    });
    req.on('error', e => {
      try { clientRes.writeHead(502); clientRes.end(`Séç Proxy upstream error: ${e.message}`); } catch(_){}
      resolve({ status:502, headers:{}, body:e.message, latency_ms:Date.now()-t0 });
    });
    if (reqObj.body) req.write(reqObj.body);
    req.end();
  });
}

// ── REST API ─────────────────────────────────────────────────
async function handleAPI(pathname, method, bodyStr, res) {
  // CORS preflight
  if (method==='OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }

  let body={};
  try { body = JSON.parse(bodyStr||'{}'); } catch(_){}

  // ── Requests ──
  if (method==='GET'  && pathname==='/api/requests') return sendJSON(res, db.list(1000));
  if (method==='GET'  && /^\/api\/requests\/\d+$/.test(pathname)) {
    const id=parseInt(pathname.split('/')[3]);
    const r=db.getById(id);
    if (!r) return sendJSON(res,{error:'not found'},404);
    return sendJSON(res, { ...r, scanner_hits:db.hitsFor(id) });
  }
  if (method==='POST' && pathname==='/api/requests/clear') { db.clearAll(); return sendJSON(res,{ok:true}); }
  if (method==='POST' && pathname==='/api/search')         return sendJSON(res, db.search(body.q||''));

  // ── Repeater ──
  if (method==='POST' && pathname==='/api/repeat') {
    const { method:m, url:u, headers:h={}, body:b } = body;
    if (!u) return sendJSON(res,{error:'url required'},400);
    const t0=Date.now();
    let pUrl;
    try { pUrl = new URL(u); } catch(_) { pUrl = new URL('https://'+u); }
    const isHTTPS=pUrl.protocol==='https:';
    const lib=isHTTPS?https:http;
    const result = await new Promise(resolve => {
      const opts = {
        hostname:pUrl.hostname,
        port:pUrl.port||(isHTTPS?443:80),
        path:(pUrl.pathname||'/')+(pUrl.search||''),
        method:m||'GET', headers:h, rejectUnauthorized:false,
      };
      const req=lib.request(opts, async r => {
        const chunks=[];
        r.on('data',c=>chunks.push(c));
        r.on('end', async()=>{
          const raw=Buffer.concat(chunks);
          const buf=await decompress(raw,r.headers['content-encoding']);
          const rh={};
          for(const[k,v] of Object.entries(r.headers)) rh[k]=v;
          resolve({ status:r.statusCode, headers:rh, body:buf.toString('utf8'), latency:Date.now()-t0 });
        });
      });
      req.on('error', e=>resolve({status:0,headers:{},body:e.message,latency:Date.now()-t0}));
      if (b) req.write(b);
      req.end();
    });
    return sendJSON(res, result);
  }

  // ── Intercept ──
  if (method==='GET'  && pathname==='/api/intercept/status') return sendJSON(res,{ enabled:intercept.enabled, pending:intercept.listPending() });
  if (method==='POST' && pathname==='/api/intercept/toggle') {
    intercept.setEnabled(!intercept.enabled);
    bridge.emitStatus({ intercept:intercept.enabled });
    return sendJSON(res,{ enabled:intercept.enabled });
  }
  if (method==='POST' && pathname==='/api/intercept/forward') {
    return sendJSON(res,{ ok:intercept.forward(body.id, body.request) });
  }
  if (method==='POST' && pathname==='/api/intercept/drop') {
    return sendJSON(res,{ ok:intercept.drop(body.id) });
  }
  if (method==='POST' && pathname==='/api/intercept/forward-all') {
    intercept.forwardAll(); return sendJSON(res,{ok:true});
  }

  // ── Intercept rules ──
  if (method==='GET'  && pathname==='/api/rules')                              return sendJSON(res,db.listRules());
  if (method==='POST' && pathname==='/api/rules')                              { db.addRule(body); return sendJSON(res,{ok:true}); }
  if (method==='DELETE' && /^\/api\/rules\/\d+$/.test(pathname))              { db.deleteRule(parseInt(pathname.split('/')[3])); return sendJSON(res,{ok:true}); }

  // ── Match-replace rules ──
  if (method==='GET'  && pathname==='/api/mr-rules')                          return sendJSON(res,db.listMR());
  if (method==='POST' && pathname==='/api/mr-rules')                          { db.addMR(body); return sendJSON(res,{ok:true}); }
  if (method==='DELETE' && /^\/api\/mr-rules\/\d+$/.test(pathname))          { db.deleteMR(parseInt(pathname.split('/')[3])); return sendJSON(res,{ok:true}); }

  // ── Saved requests ──
  if (method==='GET'  && pathname==='/api/saved')                             return sendJSON(res,db.listSaved());
  if (method==='POST' && pathname==='/api/saved')                             { db.saveRequest(body); return sendJSON(res,{ok:true}); }
  if (method==='DELETE' && /^\/api\/saved\/\d+$/.test(pathname))             { db.deleteSaved(parseInt(pathname.split('/')[3])); return sendJSON(res,{ok:true}); }

  // ── Stats ──
  if (method==='GET' && pathname==='/api/stats') return sendJSON(res,{ ...stats, uptime:Date.now()-stats.startedAt });

  // ── CA cert download ──
  if (method==='GET' && pathname==='/api/ca.crt') {
    try {
      const buf=fs.readFileSync(ca.caCertDerPath);
      res.writeHead(200,{ 'Content-Type':'application/x-x509-ca-cert', 'Content-Disposition':'attachment; filename="secproxy-ca.crt"', 'Content-Length':buf.length });
      return res.end(buf);
    } catch(_) { return sendJSON(res,{error:'CA cert not found'},404); }
  }

  // ── Proxy info ──
  if (method==='GET' && pathname==='/api/info') {
    return sendJSON(res,{ proxyHost:getLanIP(), proxyPort:PROXY_PORT, wsPort:WS_PORT });
  }

  sendJSON(res,{error:'not found'},404);
}

// ── Main server ──────────────────────────────────────────────
const server = http.createServer(async (clientReq, clientRes) => {
  const reqUrl = clientReq.url || '/';

  // Absorb any socket errors on this connection
  clientReq.socket.on('error', () => {});

  // CORS preflight to API
  if (clientReq.method === 'OPTIONS') {
    clientRes.writeHead(204, corsHeaders()); clientRes.end(); return;
  }

  // API requests from the Proxy UI (not browser traffic)
  if (reqUrl.startsWith('/api/')) {
    const bodyStr = (await collectBody(clientReq)).toString('utf8');
    return handleAPI(reqUrl.split('?')[0], clientReq.method, bodyStr, clientRes);
  }

  // ── Proxy request ────────────────────────────────────────
  stats.total++;
  const fullReqUrl = reqUrl.startsWith('http') ? reqUrl : `http://${clientReq.headers['host']||'localhost'}${reqUrl}`;
  let parsed;
  try { parsed = new URL(fullReqUrl); } catch(_) { parsed = new URL('http://localhost' + reqUrl); }
  const host   = parsed.hostname || (clientReq.headers['host']||'').split(':')[0];
  const port   = parseInt(parsed.port||80);
  const bodyBuf= await collectBody(clientReq);
  const bodyStr= bodyBuf.length ? bodyBuf.toString('utf8') : '';
  const headers= {};
  for (const [k,v] of Object.entries(clientReq.headers)) headers[k]=v;

  let reqObj = {
    method: clientReq.method, scheme:'http', host, port,
    path: (parsed.pathname||'/') + (parsed.search||''),
    url: fullReqUrl,
    headers, body:bodyStr,
  };

  // Match-replace on request
  reqObj = intercept.applyMR(reqObj, 'request');

  // Intercept pause
  let finalReq = reqObj;
  try {
    const r = await intercept.pause(reqObj);
    if (r.action==='drop') {
      stats.intercepted++;
      clientRes.writeHead(200); clientRes.end('Dropped by Séç Proxy.');
      return;
    }
    finalReq = r.request;
    if (intercept.enabled) stats.intercepted++;
  } catch(_){}

  // Store request
  const reqId = db.insertRequest(finalReq);
  bridge.emitRequest({ id:reqId, ...finalReq, req_headers:finalReq.headers, req_body:finalReq.body });

  // Forward
  const resObj = await forwardHTTP(finalReq, clientRes);

  // Match-replace on response
  const modRes = intercept.applyMR(resObj, 'response');

  // Store response
  db.updateResponse(reqId, modRes);
  stats.bytesOut += (finalReq.body||'').length;
  stats.bytesIn  += (modRes.body||'').length;

  // Passive scan
  const full = db.getById(reqId);
  const hits = scanner.scan(full);
  if (hits.length) {
    hits.forEach(h => db.addHit({ request_id:reqId, ...h }));
    bridge.emitScannerHit(reqId, hits);
  }

  bridge.emitResponse({ id:reqId, res_status:modRes.status, res_headers:modRes.headers, res_body:modRes.body, latency_ms:modRes.latency_ms });
  bridge.emitStats(stats);
});

// ── HTTPS CONNECT → MITM ─────────────────────────────────────
server.on('connect', (req, socket, head) => {
  stats.total++;
  const [hostname, portStr='443'] = (req.url||'').split(':');
  mitm.handleConnect(socket, hostname, parseInt(portStr));
});

// ── Wire intercept events → WS ───────────────────────────────
intercept.on('paused',    ({id,request}) => { stats.intercepted++; bridge.emitIntercepted(id,request); });
intercept.on('forwarded', ({id})         => bridge.emitInterceptDone(id,'forward'));
intercept.on('dropped',   ({id})         => bridge.emitInterceptDone(id,'drop'));

// ── Start — wait for DB then listen ───────────────────────────
db.init().then(() => {
  server.listen(PROXY_PORT, '0.0.0.0', () => {
    bridge.start(WS_PORT);
    const lanIP = getLanIP();
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║          Séç Proxy v2.0 — RUNNING           ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Proxy   →  0.0.0.0:${PROXY_PORT}  (${lanIP})`);
    console.log(`║  WS      →  ws://0.0.0.0:${WS_PORT}`);
    console.log(`║  API     →  http://127.0.0.1:${PROXY_PORT}/api`);
    console.log('╠══════════════════════════════════════════════╣');
    console.log('║  Browser proxy: 127.0.0.1:8080              ║');
    console.log('║  CA cert:       GET /api/ca.crt              ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  });
}).catch(e => {
  console.error('[Proxy] DB init failed:', e.message);
  process.exit(1);
});

server.on('error', e => {
  if (e.code==='EADDRINUSE') console.error(`[Proxy] Port ${PROXY_PORT} in use. Try: PROXY_PORT=8082 node server/proxy.js`);
  else console.error('[Proxy]', e.message);
  process.exit(1);
});

// Silently absorb client socket errors (browser closed tab, etc.)
server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
});

process.on('SIGINT', () => { console.log('\n[Proxy] Shutting down.'); db.close(); process.exit(0); });
