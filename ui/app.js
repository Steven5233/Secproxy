/* ============================================================
   ui/app.js — Séç Proxy v2.0 — Complete frontend JS
   ============================================================ */
'use strict';

// ── Config ───────────────────────────────────────────────────
const API  = `http://${location.hostname}:8080`;
const WS   = `ws://${location.hostname}:8081`;

// ── State ────────────────────────────────────────────────────
let rows        = [];       // all captured requests
let filtered    = [];       // after filters
let selHistId   = null;     // selected row in proxy tab
let pendingQ    = {};       // id → request (intercept queue)
let selIntId    = null;     // selected intercept item
let intEnabled  = false;
let repBodyType = 'json';
let repRespData = { body:'', headers:'', raw:'' };
let repRespTab  = 'body';
let ws          = null;
let wsTimer     = null;

const MC = { GET:'var(--mget)', POST:'var(--mpost)', PUT:'var(--mput)', DELETE:'var(--mdel)', PATCH:'var(--mpatch)', HEAD:'var(--text2)', OPTIONS:'var(--text2)' };

// ══════════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════════
function wsConnect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  ws = new WebSocket(WS);
  const dot = document.getElementById('wsDot');

  ws.onopen = () => {
    dot.className = 'ws-dot connected';
    dot.title = 'WebSocket connected';
    clearTimeout(wsTimer);
    histLoad();
    intLoadStatus();
    statsLoad();
    settingsLoad();
  };
  ws.onclose = () => {
    dot.className = 'ws-dot disconnected';
    dot.title = 'WebSocket disconnected — retrying…';
    wsTimer = setTimeout(wsConnect, 3000);
  };
  ws.onerror  = () => ws.close();
  ws.onmessage = e => {
    try { wsHandle(JSON.parse(e.data)); } catch(_) {}
  };
}

function wsHandle(msg) {
  switch (msg.type) {
    case 'request': {
      rows.unshift(msg.entry);
      if (rows.length > 2000) rows.pop();
      applyFilters();
      document.getElementById('statTotal').textContent = rows.length + ' reqs';
      break;
    }
    case 'response': {
      const r = rows.find(x => x.id === msg.entry.id);
      if (r) Object.assign(r, msg.entry);
      applyFilters();
      if (selHistId === msg.entry.id) detailShow(msg.entry.id);
      break;
    }
    case 'intercepted': {
      pendingQ[msg.id] = msg.request;
      intRenderQueue();
      intBadge();
      showTab('intercept');
      break;
    }
    case 'intercept_resolved': {
      delete pendingQ[msg.id];
      if (selIntId == msg.id) { selIntId = null; document.getElementById('iEditor').value = ''; }
      intRenderQueue(); intBadge();
      break;
    }
    case 'scanner_hit': scanLoad(); break;
    case 'stats':  statsApply(msg.stats); break;
    case 'status': if (msg.status?.intercept != null) { intEnabled = msg.status.intercept; intBtn(); } break;
  }
}

// ══════════════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════════════
document.getElementById('mainTabs').addEventListener('click', e => {
  if (e.target.dataset.tab) showTab(e.target.dataset.tab);
});

function showTab(name) {
  document.querySelectorAll('.mtab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + name));
  if (name === 'settings') settingsLoad();
  if (name === 'scanner')  scanLoad();
  if (name === 'intercept') intLoadStatus();
}

// ══════════════════════════════════════════════════════════════
// REST HELPER
// ══════════════════════════════════════════════════════════════
async function api(path, method='GET', body) {
  const opts = { method, headers:{'Content-Type':'application/json'} };
  if (body) opts.body = JSON.stringify(body);
  try { return await (await fetch(API + path, opts)).json(); }
  catch(e) { return { error: e.message }; }
}

// ══════════════════════════════════════════════════════════════
// PROXY TAB — HISTORY
// ══════════════════════════════════════════════════════════════
async function histLoad() {
  const data = await api('/api/requests');
  if (Array.isArray(data)) {
    rows = data;
    applyFilters();
    document.getElementById('statTotal').textContent = rows.length + ' reqs';
  }
}

function applyFilters() {
  const q  = (document.getElementById('histSearch').value  || '').toLowerCase();
  const fm = document.getElementById('filterMethod').value || '';
  const fs = document.getElementById('filterStatus').value || '';
  filtered = rows.filter(r => {
    if (fm && r.method !== fm)                               return false;
    if (fs && !String(r.res_status||'').startsWith(fs))     return false;
    if (q && !((r.host||'')+(r.url||'')+(r.res_status||'')).toLowerCase().includes(q)) return false;
    return true;
  });
  histRender();
}

function histRender() {
  const tbody = document.getElementById('histBody');
  tbody.innerHTML = '';
  filtered.forEach(r => {
    const tr = document.createElement('tr');
    if (r.flagged)    tr.classList.add('flagged');
    if (r.id === selHistId) tr.classList.add('sel');
    const sc = r.res_status;
    const scls = sc ? (sc>=500?'s5':sc>=400?'s4':sc>=300?'s3':'s2') : '';
    const size = r.res_body ? fmtSize((r.res_body||'').length) : '—';
    const path = (r.path||'/').slice(0,55);
    tr.innerHTML = `
      <td>${r.id}</td>
      <td class="mc ${r.method}">${r.method}</td>
      <td title="${esc(r.host||'')}">${esc((r.host||'').replace(/^www\./,''))}</td>
      <td title="${esc(r.path||'')}">${esc(path)}</td>
      <td class="${scls}">${sc||'—'}</td>
      <td>${size}</td>
      <td>${r.latency_ms!=null?r.latency_ms:'—'}</td>
      <td><button class="rep-ico" title="→ Repeater" onclick="repLoadFromHist(${r.id},event)">↺</button></td>
    `;
    tr.onclick = e => { if (e.target.classList.contains('rep-ico')) return; histSelect(r.id, tr); };
    tbody.appendChild(tr);
  });
}

async function histSelect(id, tr) {
  document.querySelectorAll('#histBody tr').forEach(r => r.classList.remove('sel'));
  if (tr) tr.classList.add('sel');
  selHistId = id;
  await detailShow(id);
}

async function detailShow(id) {
  const r = await api(`/api/requests/${id}`);
  if (r.error) return;
  const qH = safeJSON(r.req_headers, {});
  const rH = safeJSON(r.res_headers, {});
  // Normalise: DB may return headers as object or JSON string — safeJSON handles both
  // but also guard against null/undefined from incomplete captures
  const wrap = document.getElementById('detailWrap');
  wrap.innerHTML = `
    <div class="detail-tabs" id="dtabs">
      <button class="dtab active" onclick="dSwitch(this,'req')">Request</button>
      <button class="dtab" onclick="dSwitch(this,'res')">Response</button>
      <button class="dtab" onclick="dSwitch(this,'raw')">Raw</button>
      ${r.scanner_hits?.length ? `<button class="dtab" onclick="dSwitch(this,'hits')">Hits (${r.scanner_hits.length})</button>` : ''}
    </div>
    <div class="detail-body" id="dbody">
      <div id="dp-req">
        <table class="kv-view">
          <tr><td>Method</td><td>${r.method}</td></tr>
          <tr><td>URL</td><td style="word-break:break-all">${esc(r.url)}</td></tr>
          ${Object.entries(qH).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}
        </table>
        ${r.req_body ? `<pre class="resp-pre" style="max-height:180px">${colorJSON(r.req_body)}</pre>` : ''}
      </div>
      <div id="dp-res" style="display:none">
        <table class="kv-view">
          <tr><td>Status</td><td>${r.res_status||'—'}</td></tr>
          <tr><td>Latency</td><td>${r.latency_ms!=null?r.latency_ms+'ms':'—'}</td></tr>
          ${Object.entries(rH).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}
        </table>
        ${r.res_body ? `<pre class="resp-pre" style="max-height:280px">${colorJSON(r.res_body)}</pre>` : ''}
      </div>
      <div id="dp-raw" style="display:none">
        <pre class="resp-pre">${esc(buildRaw(r))}</pre>
      </div>
      ${r.scanner_hits?.length ? `
      <div id="dp-hits" style="display:none;padding:10px">
        ${r.scanner_hits.map(h => hitCard(h, r.url)).join('')}
      </div>` : ''}
    </div>
    <div class="detail-foot">
      <button class="btn accent" onclick="repLoadFromHist(${r.id})">↺ Repeater</button>
      <button class="btn" onclick="copyRaw(${r.id})">Copy Raw</button>
      <button class="btn" onclick="saveReq(${r.id})">💾 Save</button>
    </div>`;
}

function dSwitch(btn, name) {
  btn.closest('#dtabs').querySelectorAll('.dtab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('[id^=dp-]').forEach(el => el.style.display='none');
  const el = document.getElementById('dp-'+name);
  if (el) el.style.display = '';
}

function buildRaw(r) {
  const qH = safeJSON(r.req_headers,{});
  const rH = safeJSON(r.res_headers,{});
  const req = `${r.method} ${r.path} HTTP/1.1\r\n`
    + Object.entries(qH).map(([k,v])=>`${k}: ${v}`).join('\r\n')
    + `\r\n\r\n${r.req_body||''}`;
  const res = r.res_status
    ? `HTTP/1.1 ${r.res_status}\r\n`
      + Object.entries(rH).map(([k,v])=>`${k}: ${v}`).join('\r\n')
      + `\r\n\r\n${r.res_body||''}`
    : '(no response)';
  return `=== REQUEST ===\n${req}\n\n=== RESPONSE ===\n${res}`;
}

async function copyRaw(id) {
  const r = await api(`/api/requests/${id}`);
  if (!r.error) await navigator.clipboard?.writeText(buildRaw(r));
  toast('Copied!');
}

async function saveReq(id) {
  const name = prompt('Save as (name):');
  if (!name) return;
  const r = await api(`/api/requests/${id}`);
  await api('/api/saved','POST',{ name, folder:'Default', request_id:id, raw:buildRaw(r) });
  toast('Saved!');
}

async function clearHistory() {
  if (!confirm('Clear all captured requests?')) return;
  await api('/api/requests/clear','POST');
  rows = []; filtered = []; histRender();
  document.getElementById('detailWrap').innerHTML = `<div class="empty-state"><div class="empty-icon">⬡</div><p>Select a request</p></div>`;
  document.getElementById('statTotal').textContent = '0 reqs';
}

async function exportHAR() {
  toast('Preparing HAR export…');
  // Fetch full data for each row (list() omits res_body for performance)
  const full = await Promise.all(filtered.map(r => api(`/api/requests/${r.id}`)));
  const entries = full.filter(r => !r.error).map(r => {
    const qH = safeJSON(r.req_headers, {}), rH = safeJSON(r.res_headers, {});
    return {
      startedDateTime: new Date(r.ts).toISOString(), time: r.latency_ms || 0,
      request: {
        method: r.method, url: r.url, httpVersion: 'HTTP/1.1',
        headers: Object.entries(qH).map(([n, v]) => ({ name: n, value: String(v) })),
        queryString: [], cookies: [], headersSize: -1, bodySize: (r.req_body || '').length,
        postData: r.req_body ? { mimeType: qH['content-type'] || '', text: r.req_body } : undefined,
      },
      response: {
        status: r.res_status || 0, statusText: '', httpVersion: 'HTTP/1.1',
        headers: Object.entries(rH).map(([n, v]) => ({ name: n, value: String(v) })),
        cookies: [], redirectURL: '', headersSize: -1, bodySize: (r.res_body || '').length,
        content: { size: (r.res_body || '').length, mimeType: rH['content-type'] || '', text: r.res_body || '' },
      },
      cache: {}, timings: { send: 0, wait: r.latency_ms || 0, receive: 0 },
    };
  });
  const blob = new Blob(
    [JSON.stringify({ log: { version: '1.2', creator: { name: 'Séç Proxy', version: '2.0' }, entries } }, null, 2)],
    { type: 'application/json' }
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `secproxy-${Date.now()}.har`;
  a.click();
  toast(`Exported ${entries.length} requests ✓`);
}

// ══════════════════════════════════════════════════════════════
// INTERCEPT TAB
// ══════════════════════════════════════════════════════════════
async function intLoadStatus() {
  const r = await api('/api/intercept/status');
  if (r.error) return;
  intEnabled = r.enabled; intBtn();
  if (r.pending) { r.pending.forEach(p => { pendingQ[p.id]=p; }); intRenderQueue(); intBadge(); }
}

async function toggleIntercept() {
  const r = await api('/api/intercept/toggle','POST');
  if (!r.error) { intEnabled=r.enabled; intBtn(); toast(r.enabled?'Intercept ON':'Intercept OFF'); }
}

function intBtn() {
  const btn = document.getElementById('interceptToggle');
  btn.textContent = intEnabled ? 'Intercept ON' : 'Intercept OFF';
  btn.classList.toggle('on', intEnabled);
}

function intRenderQueue() {
  const el = document.getElementById('iQueue');
  const items = Object.entries(pendingQ);
  document.getElementById('pendingCount').textContent = items.length;
  if (!items.length) { el.innerHTML=`<div class="empty-state" style="padding:20px"><p>No intercepted requests</p></div>`; return; }
  el.innerHTML = items.map(([id,req]) =>
    `<div class="qi ${selIntId==id?'active':''}" onclick="intSelect(${id})">
      <div class="qi-method" style="color:${MC[req.method]||'var(--text2)'}">${req.method} <span style="color:var(--text3);font-weight:400">${req.host||''}</span></div>
      <div class="qi-url">${esc(req.url||req.path||'')}</div>
      <div class="qi-time">${new Date(req.ts||Date.now()).toLocaleTimeString()}</div>
    </div>`
  ).join('');
}

function intBadge() {
  const n = Object.keys(pendingQ).length;
  const b = document.getElementById('interceptBadge');
  b.textContent = n; b.style.display = n ? '' : 'none';
}

function intSelect(id) {
  selIntId = id;
  const req = pendingQ[id];
  if (!req) return;
  const hlines = Object.entries(req.headers||{}).map(([k,v])=>`${k}: ${v}`).join('\r\n');
  const raw = `${req.method} ${req.path||'/'} HTTP/1.1\r\n${hlines}\r\n\r\n${req.body||''}`;
  document.getElementById('iEditor').value = raw;

  // Populate parsed view
  const tbl = document.getElementById('iParsed');
  tbl.innerHTML = `<tr style="background:var(--sur2)"><td>Method</td><td><b style="color:${MC[req.method]||'var(--text2)'}">${req.method}</b></td></tr>
    <tr><td>URL</td><td style="word-break:break-all">${esc(req.url||'')}</td></tr>
    ${Object.entries(req.headers||{}).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}
    ${req.body?`<tr><td>Body</td><td><pre style="white-space:pre-wrap">${esc(req.body)}</pre></td></tr>`:''}`;

  intRenderQueue();
}

function intParseRaw(raw) {
  const sep  = raw.indexOf('\r\n\r\n');
  const head = sep >= 0 ? raw.slice(0,sep) : raw;
  const body = sep >= 0 ? raw.slice(sep+4) : '';
  const lines = head.split('\r\n');
  const [method='GET', path='/'] = (lines[0]||'').split(' ');
  const headers = {};
  for (let i=1; i<lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c<0) continue;
    headers[lines[i].slice(0,c).trim()] = lines[i].slice(c+1).trim();
  }
  return { method, path, headers, body };
}

async function forwardCurrent() {
  if (!selIntId) return toast('Select a paused request');
  const parsed  = intParseRaw(document.getElementById('iEditor').value);
  const orig    = pendingQ[selIntId] || {};
  await api('/api/intercept/forward','POST',{ id:selIntId, request:{ ...orig, ...parsed } });
}

async function dropCurrent() {
  if (!selIntId) return toast('Select a paused request');
  await api('/api/intercept/drop','POST',{ id:selIntId });
}

async function forwardAll() {
  await api('/api/intercept/forward-all','POST');
}

// Subtabs in intercept
document.getElementById('iSubtabs').addEventListener('click', e => {
  const btn = e.target.closest('.stab');
  if (!btn) return;
  document.querySelectorAll('#iSubtabs .stab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.ipane').forEach(p => p.style.display='none');
  const pane = document.getElementById('ipane-'+btn.dataset.pane);
  if (pane) { pane.style.display='flex'; pane.classList.add('active'); }
});

// ══════════════════════════════════════════════════════════════
// REPEATER TAB
// ══════════════════════════════════════════════════════════════
function repColorMethod() {
  const s = document.getElementById('rMethod');
  s.style.color = MC[s.value] || 'var(--text)';
}
repColorMethod();

function repSetBody(btn, type) {
  document.querySelectorAll('.btype').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  repBodyType = type;
  const fm = document.getElementById('rFmBody');
  const ta = document.getElementById('rBodyTA');
  if (type==='form') { fm.style.display=''; ta.style.display='none'; }
  else if (type==='none') { fm.style.display='none'; ta.style.display='none'; }
  else { fm.style.display='none'; ta.style.display=''; }
  if (type==='json' && !ta.value) ta.value='{\n  \n}';
  if (type==='xml'  && !ta.value) ta.value='<?xml version="1.0"?>\n<root>\n</root>';
}

function repFmtJSON() {
  const ta = document.getElementById('rBodyTA');
  try { ta.value = JSON.stringify(JSON.parse(ta.value),null,2); } catch(_) {}
}

async function repSend() {
  const urlVal = document.getElementById('rUrl').value.trim();
  if (!urlVal) return toast('Enter a URL');

  const method  = document.getElementById('rMethod').value;
  const headers = {};
  kvGet('rHdrTable').forEach(h => { headers[h.k]=h.v; });
  const cookies = kvGet('rCkTable');
  if (cookies.length) headers['Cookie'] = cookies.map(c=>`${c.k}=${c.v}`).join('; ');

  let finalUrl = urlVal;
  const params = kvGet('rParTable');
  if (params.length) {
    const base = urlVal.split('?')[0];
    finalUrl = base+'?'+params.map(p=>encodeURIComponent(p.k)+'='+encodeURIComponent(p.v)).join('&');
  }

  let body;
  if (repBodyType==='form') {
    body = kvGet('rFmTable').map(f=>encodeURIComponent(f.k)+'='+encodeURIComponent(f.v)).join('&');
    headers['Content-Type']='application/x-www-form-urlencoded';
  } else if (repBodyType!=='none') {
    body = document.getElementById('rBodyTA').value || undefined;
  }

  const btn = document.getElementById('rSendBtn');
  btn.textContent='…';
  document.getElementById('resEmpty').style.display='none';
  document.getElementById('resLoading').style.display='flex';
  document.getElementById('resBody').style.display='none';
  document.getElementById('resTopbar').style.visibility='hidden';

  const r = await api('/api/repeat','POST',{ method, url:finalUrl, headers, body });

  btn.textContent='▶ Send';
  document.getElementById('resLoading').style.display='none';
  document.getElementById('resTopbar').style.visibility='visible';

  const badge = document.getElementById('rStatusBadge');
  badge.textContent = String(r.status||0);
  badge.className = 'status-badge';
  const s=r.status||0;
  if (s>=500) badge.classList.add('s5xx');
  else if (s>=400) badge.classList.add('s4xx');
  else if (s>=300) badge.classList.add('s3xx');
  else badge.classList.add('s2xx');

  document.getElementById('rMeta').innerHTML = `<b>${r.latency}ms</b> · <b>${fmtSize((r.body||'').length)}</b>`;
  repRespData.body    = colorJSON(r.body||'');
  repRespData.headers = Object.entries(r.headers||{}).map(([k,v])=>`<span class="jk">${esc(k)}</span>: <span class="js">${esc(String(v))}</span>`).join('\n');
  repRespData.raw     = `HTTP/1.1 ${r.status}\n`+Object.entries(r.headers||{}).map(([k,v])=>`${k}: ${v}`).join('\n')+'\n\n'+(r.body||'');
  repShowBody();
  document.getElementById('resBody').style.display='';
}

function repShowTab(btn, tab) {
  document.querySelectorAll('#resTopbar .stab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  repRespTab = tab;
  repShowBody();
}

function repShowBody() {
  const el = document.getElementById('resBody');
  if (repRespTab==='body')    el.innerHTML = repRespData.body;
  else if (repRespTab==='headers') el.innerHTML = repRespData.headers;
  else el.innerHTML = esc(repRespData.raw);
}

function repCopy() {
  navigator.clipboard?.writeText(repRespData.raw).then(() => toast('Copied!'));
}

async function repLoadFromHist(id, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  const r = await api(`/api/requests/${id}`);
  if (r.error) return toast('Could not load request #' + id);
  document.getElementById('rUrl').value    = r.url || '';
  document.getElementById('rMethod').value = r.method || 'GET';
  repColorMethod();
  // Clear and reload headers
  document.getElementById('rHdrTable').innerHTML = '';
  const hdrs = safeJSON(r.req_headers, {});
  Object.entries(hdrs).forEach(([k, v]) => kvAdd('rHdrTable', 'rHdr', k, String(v)));
  kvCount('rHdr');
  // Load cookies
  document.getElementById('rCkTable').innerHTML = '';
  const cookieHdr = hdrs['cookie'] || hdrs['Cookie'] || '';
  if (cookieHdr) {
    cookieHdr.split(';').forEach(part => {
      const eq = part.indexOf('=');
      if (eq > 0) kvAdd('rCkTable', 'rCk', part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    });
    kvCount('rCk');
  }
  // Load body
  if (r.req_body) {
    document.getElementById('rBodyTA').value = r.req_body;
    const ct = (safeJSON(r.req_headers, {})['content-type'] || '').toLowerCase();
    if (ct.includes('application/json') || !ct) {
      document.querySelectorAll('.btype').forEach(b => b.classList.remove('active'));
      document.querySelector('.btype[onclick*="json"]')?.classList.add('active');
      repBodyType = 'json';
    } else if (ct.includes('form')) {
      document.querySelectorAll('.btype').forEach(b => b.classList.remove('active'));
      document.querySelector('.btype[onclick*="form"]')?.classList.add('active');
      repBodyType = 'form';
    }
  } else {
    document.getElementById('rBodyTA').value = '';
  }
  showTab('repeater');
  toast('Loaded into Repeater ✓');
}

// ── Resize handle ────────────────────────────────────────────
(function() {
  const h = document.getElementById('rHandle');
  const p = document.getElementById('reqPanel');
  let drag=false, sx=0, sw=0;
  h.addEventListener('mousedown', e => { drag=true; sx=e.clientX; sw=p.offsetWidth; document.body.style.userSelect='none'; });
  h.addEventListener('touchstart', e => { drag=true; sx=e.touches[0].clientX; sw=p.offsetWidth; }, {passive:true});
  document.addEventListener('mousemove', e => { if (!drag) return; p.style.width=Math.max(160,Math.min(700,sw+(e.clientX-sx)))+'px'; });
  document.addEventListener('touchmove', e => { if (!drag) return; p.style.width=Math.max(160,Math.min(700,sw+(e.touches[0].clientX-sx)))+'px'; }, {passive:true});
  document.addEventListener('mouseup',  () => { drag=false; document.body.style.userSelect=''; });
  document.addEventListener('touchend', () => { drag=false; });
})();

// ══════════════════════════════════════════════════════════════
// DECODER TAB
// ══════════════════════════════════════════════════════════════
async function decRun() {
  const op  = document.getElementById('decOp').value;
  const inp = document.getElementById('decIn').value;
  const out = document.getElementById('decOut');
  let result='';
  try {
    switch(op) {
      case 'b64d':   result = atob(inp.trim()); break;
      case 'b64e':   result = btoa(unescape(encodeURIComponent(inp))); break;
      case 'urld':   result = decodeURIComponent(inp); break;
      case 'urle':   result = encodeURIComponent(inp); break;
      case 'htmld':  { const t=document.createElement('textarea'); t.innerHTML=inp; result=t.value; break; }
      case 'htmle':  result = inp.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); break;
      case 'hexd':   result = (inp.replace(/\s/g,'').match(/.{1,2}/g)||[]).map(b=>String.fromCharCode(parseInt(b,16))).join(''); break;
      case 'hexe':   result = [...inp].map(c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join(' '); break;
      case 'jwt': {
        const parts = inp.split('.');
        const decode = s => JSON.parse(decodeURIComponent(atob(s.replace(/-/g,'+').replace(/_/g,'/')).split('').map(c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join('')));
        const header  = decode(parts[0]||'');
        const payload = decode(parts[1]||'');
        result = `=== HEADER ===\n${JSON.stringify(header,null,2)}\n\n=== PAYLOAD ===\n${JSON.stringify(payload,null,2)}\n\n=== SIGNATURE ===\n${parts[2]||'(none)'}`;
        break;
      }
      case 'json':   result = JSON.stringify(JSON.parse(inp),null,2); break;
      case 'sha256': {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inp));
        result = Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
        break;
      }
      default: result = inp;
    }
  } catch(e) { result = 'Error: '+e.message; }
  out.textContent = result;
}

function decSwap() {
  const i=document.getElementById('decIn'), o=document.getElementById('decOut');
  i.value=o.textContent; o.textContent='';
}

function decCopy() {
  navigator.clipboard?.writeText(document.getElementById('decOut').textContent).then(()=>toast('Copied!'));
}

function decToRep() {
  document.getElementById('rBodyTA').value = document.getElementById('decOut').textContent;
  showTab('repeater'); toast('Sent to Repeater body');
}

// ══════════════════════════════════════════════════════════════
// SCANNER TAB
// ══════════════════════════════════════════════════════════════
async function scanLoad() {
  const data = await api('/api/requests');
  if (!Array.isArray(data)) return;
  const flagged = data.filter(r => r.flagged);
  document.getElementById('scanCount').textContent = flagged.length;
  const el = document.getElementById('scanList');
  if (!flagged.length) { el.innerHTML=`<div class="empty-state" style="padding:40px"><p>No scanner hits yet.<br><small>Traffic is analysed automatically.</small></p></div>`; return; }
  el.innerHTML='';
  for (const row of flagged) {
    const full = await api(`/api/requests/${row.id}`);
    (full.scanner_hits||[]).forEach(h => { el.innerHTML += hitCard(h, row.url); });
  }
}

function hitCard(h, url) {
  const cls = {info:'sev-info',low:'sev-low',medium:'sev-medium',high:'sev-high'}[h.severity]||'sev-info';
  return `<div class="hit-card">
    <div class="hit-head"><span class="sev ${cls}">${h.severity}</span><span class="hit-type">${esc(h.type)}</span></div>
    <div class="hit-detail">${esc(h.detail)}</div>
    ${url?`<div class="hit-url">${esc(url)}</div>`:''}
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// SETTINGS TAB
// ══════════════════════════════════════════════════════════════
async function settingsLoad() {
  const info = await api('/api/info');
  if (!info.error) {
    document.getElementById('sHost').textContent = info.proxyHost;
    document.getElementById('sPort').textContent = info.proxyPort;
    document.getElementById('sWS').textContent   = info.wsPort;
  }
  rulesLoad(); mrLoad(); statsLoad();
}

async function rulesLoad() {
  const rules = await api('/api/rules');
  if (!Array.isArray(rules)) return;
  document.getElementById('ruleList').innerHTML = rules.length
    ? rules.map(r=>`<div class="rule-row"><span style="color:var(--info)">${r.field}</span><span style="color:var(--text3)">${r.op}</span><span>${esc(r.value)}</span><button class="rule-del" onclick="ruleDel(${r.id})">×</button></div>`).join('')
    : `<p class="hint" style="margin:4px 0">No rules — intercepting all traffic.</p>`;
}

async function ruleAdd() {
  const v = document.getElementById('rVal').value.trim();
  if (!v) return toast('Enter a value');
  await api('/api/rules','POST',{ enabled:1, field:document.getElementById('rField').value, op:document.getElementById('rOp').value, value:v });
  document.getElementById('rVal').value='';
  rulesLoad();
}

async function ruleDel(id) { await api(`/api/rules/${id}`,'DELETE'); rulesLoad(); }

async function mrLoad() {
  const rules = await api('/api/mr-rules');
  if (!Array.isArray(rules)) return;
  document.getElementById('mrList').innerHTML = rules.length
    ? rules.map(r=>`<div class="rule-row"><span style="color:var(--warn)">${r.scope}</span><span style="color:var(--info)">${r.field}</span><span>${esc(r.match_str)}</span><span style="color:var(--text3)">→</span><span>${esc(r.replace)}</span><button class="rule-del" onclick="mrDel(${r.id})">×</button></div>`).join('')
    : `<p class="hint" style="margin:4px 0">No match-replace rules.</p>`;
}

async function mrAdd() {
  const match = document.getElementById('mrMatch').value.trim();
  if (!match) return toast('Enter a match pattern');
  await api('/api/mr-rules','POST',{
    enabled:1, scope:document.getElementById('mrScope').value,
    field:document.getElementById('mrField').value,
    match_str:match, replace:document.getElementById('mrReplace').value, use_regex:0,
  });
  document.getElementById('mrMatch').value='';
  document.getElementById('mrReplace').value='';
  mrLoad();
}

async function mrDel(id) { await api(`/api/mr-rules/${id}`,'DELETE'); mrLoad(); }

async function statsLoad() {
  const s = await api('/api/stats');
  if (s.error) return;
  statsApply(s);
}

function statsApply(s) {
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  set('stTotal', s.total||0);
  set('stInt',   s.intercepted||0);
  set('stErr',   s.errors||0);
  set('stBin',   fmtSize(s.bytesIn||0));
  set('stBout',  fmtSize(s.bytesOut||0));
  set('stUp',    fmtUp(s.uptime||0));
  set('statTotal', (s.total||0)+' reqs');
}

// ══════════════════════════════════════════════════════════════
// KV TABLE HELPERS
// ══════════════════════════════════════════════════════════════
const KV_COLOR = { rHdr:'var(--info)', rPar:'var(--warn)', rCk:'var(--mpost)', rFm:'var(--accent)' };

function kvAdd(tableId, key, k='', v='', enabled=true) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const row = document.createElement('div');
  row.className = 'kv-row';
  const ck = document.createElement('div'); ck.className='kv-ck';
  const cb = document.createElement('input'); cb.type='checkbox'; cb.checked=enabled; cb.onchange=()=>kvCount(key);
  ck.appendChild(cb);
  const ki = document.createElement('input'); ki.className='kv-k'; ki.placeholder='Key'; ki.value=k; ki.style.color=KV_COLOR[key]||'var(--info)';
  const vi = document.createElement('input'); vi.className='kv-v'; vi.placeholder='Value'; vi.value=v;
  const dl = document.createElement('div'); dl.className='kv-del';
  const db2 = document.createElement('button'); db2.textContent='×'; db2.onclick=()=>{ row.remove(); kvCount(key); };
  dl.appendChild(db2);
  row.append(ck,ki,vi,dl); table.appendChild(row);
  kvCount(key);
}

function kvGet(tableId) {
  const rows=[];
  document.querySelectorAll(`#${tableId} .kv-row`).forEach(row => {
    const cb = row.querySelector('input[type=checkbox]');
    const [ki,vi] = row.querySelectorAll('input.kv-k,input.kv-v');
    if (ki?.value && cb?.checked) rows.push({ k:ki.value, v:vi?.value||'' });
  });
  return rows;
}

function kvCount(key) {
  const t = { rHdr:'rHdrTable', rPar:'rParTable', rCk:'rCkTable', rFm:'rFmTable' }[key];
  const n = document.querySelectorAll(`#${t} input[type=checkbox]:checked`).length;
  const el = document.getElementById(key+'-count');
  if (el) el.textContent=n;
}

function toggleAcc(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display==='none' ? '' : 'none';
}

// ══════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════
function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function colorJSON(raw) {
  if (!raw) return '';
  let s = raw;
  try { s = JSON.stringify(JSON.parse(raw),null,2); } catch(_) {}
  return esc(s).replace(
    /(&quot;(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\&])*&quot;(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    m => {
      if (/^&quot;/.test(m)) return /:$/.test(m) ? `<span class="jk">${m}</span>` : `<span class="js">${m}</span>`;
      if (/true|false/.test(m)) return `<span class="jb">${m}</span>`;
      if (/null/.test(m))       return `<span class="jnull">${m}</span>`;
      return `<span class="jn">${m}</span>`;
    }
  );
}

function fmtSize(n) {
  if (n<1024)    return n+' B';
  if (n<1048576) return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}

function fmtUp(ms) {
  const s=Math.floor(ms/1000);
  if (s<60)   return s+'s';
  if (s<3600) return Math.floor(s/60)+'m '+s%60+'s';
  return Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m';
}

function safeJSON(s, fb) {
  if (!s) return fb;
  if (typeof s==='object') return s;
  try { return JSON.parse(s); } catch(_) { return fb; }
}

function toast(msg) {
  const el=document.createElement('div'); el.className='toast'; el.textContent=msg;
  document.body.appendChild(el); setTimeout(()=>el.remove(),2200);
}

// ── Keyboard shortcut: Ctrl+Enter sends in Repeater ──────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key==='Enter') { e.preventDefault(); if (document.getElementById('tab-repeater').classList.contains('active')) repSend(); }
});

// ── Init defaults ─────────────────────────────────────────────
kvAdd('rHdrTable','rHdr','Content-Type','application/json');
kvAdd('rHdrTable','rHdr','Accept','*/*');

// ── Boot ──────────────────────────────────────────────────────
wsConnect();

// ══════════════════════════════════════════════════════════════
//  BUILT-IN BROWSER — complete rewrite
//
//  Architecture:
//    1. User types URL → bFetchWithOpts() called
//    2. Fetch goes to /proxy-browse?url=... on ui-server.js
//    3. ui-server.js routes it through proxy.js:8080 (captured!)
//    4. Response HTML returned to browser tab
//    5. bRenderHTML() injects into srcdoc iframe with:
//       - Correct <base> tag
//       - Asset URL rewriting (src/href → /proxy-asset?url=...)
//       - Link/form interception script via postMessage
//
//  Fixes:
//  FIX-B3: All asset URLs (img src, link href, script src, CSS url())
//           rewritten to /proxy-asset?url=... so they load correctly
//           inside srcdoc iframe (which has no real origin).
//  FIX-B4: Removed allow-same-origin from iframe sandbox. It was
//           causing postMessage origin mismatches. The interception
//           script now uses '*' as the target origin.
//  FIX-B5: <base> tag deduplication now uses a single reliable inject
//           that removes ALL existing base tags first, then adds ours.
//  FIX-B6: Click interception now uses capture phase (true) with
//           stopPropagation AFTER sending postMessage so sites that
//           call stopPropagation internally still get intercepted.
//  FIX-B7: Fetch timeout controller — navigation away from a page
//           while loading aborts the in-flight fetch so the browser
//           tab doesn't remain stuck on "loading".
// ══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  let bNavHistory  = [];
  let bHistIdx     = -1;
  let bCurrentUrl  = '';
  let bAbortCtrl   = null;   // FIX-B7: abort controller for in-flight fetch

  // ── Public API ───────────────────────────────────────────────
  window.bGo        = function(url) { bLoadUrl(url); };
  window.bNavigate  = function() {
    let url = (el('bUrlbar') ? el('bUrlbar').value : '').trim();
    if (!url) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;
    bLoadUrl(url);
  };
  window.bGoBack    = function() { if (bHistIdx > 0)                      { bHistIdx--; bFetch(bNavHistory[bHistIdx]); } };
  window.bGoForward = function() { if (bHistIdx < bNavHistory.length - 1) { bHistIdx++; bFetch(bNavHistory[bHistIdx]); } };
  window.bReload    = function() { if (bCurrentUrl) bFetch(bCurrentUrl); };

  // ── postMessage from iframe ──────────────────────────────────
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;
    switch (e.data.type) {
      case 'proxy-navigate':
        if (e.data.url) bLoadUrl(e.data.url);
        break;
      case 'proxy-submit':
        if (e.data.url) {
          if (bHistIdx < bNavHistory.length - 1) bNavHistory = bNavHistory.slice(0, bHistIdx + 1);
          bNavHistory.push(e.data.url);
          bHistIdx = bNavHistory.length - 1;
          bFetchWithOpts(e.data.url, {
            method:      e.data.method || 'POST',
            body:        e.data.body,
            contentType: e.data.contentType || 'application/x-www-form-urlencoded',
          });
        }
        break;
    }
  });

  function bLoadUrl(url) {
    if (bHistIdx < bNavHistory.length - 1) bNavHistory = bNavHistory.slice(0, bHistIdx + 1);
    bNavHistory.push(url);
    bHistIdx = bNavHistory.length - 1;
    bFetch(url);
  }

  function bFetch(url) { bFetchWithOpts(url, { method: 'GET' }); }

  // ── Core fetch ────────────────────────────────────────────────
  async function bFetchWithOpts(url, opts) {
    // FIX-B7: Abort any previous in-flight request
    if (bAbortCtrl) { try { bAbortCtrl.abort(); } catch (_) {} }
    bAbortCtrl = new AbortController();
    const signal = bAbortCtrl.signal;

    bCurrentUrl = url;
    const urlbar      = el('bUrlbar');
    const welcome     = el('bWelcome');
    const loadOverlay = el('bLoadOverlay');
    const errorPane   = el('bErrorPane');
    const pageContent = el('bPageContent');
    const statusText  = el('bStatusText');
    const loadMsg     = el('bLoadMsg');

    if (urlbar)      urlbar.value                 = url;
    if (welcome)     welcome.style.display        = 'none';
    if (pageContent) pageContent.style.display    = 'none';
    if (errorPane)   errorPane.style.display      = 'none';
    if (loadOverlay) loadOverlay.style.display    = 'flex';
    if (loadMsg)     loadMsg.textContent          = 'Connecting to ' + url + '…';
    if (statusText)  statusText.textContent       = '';

    bBumpCapture();

    try {
      const fetchOpts = { method: opts.method || 'GET', headers: {}, signal };
      if (opts.body) {
        fetchOpts.body = opts.body;
        fetchOpts.headers['Content-Type'] = opts.contentType || 'application/x-www-form-urlencoded';
      }

      const resp = await fetch('/proxy-browse?url=' + encodeURIComponent(url), fetchOpts);

      if (signal.aborted) return; // navigated away

      const finalUrl = resp.headers.get('x-final-url') || url;
      if (finalUrl !== url) {
        bCurrentUrl           = finalUrl;
        bNavHistory[bHistIdx] = finalUrl;
        if (urlbar) urlbar.value = finalUrl;
      }

      if (statusText) statusText.textContent = resp.status + ' ' + (resp.statusText || '');

      const ct = (resp.headers.get('content-type') || '').split(';')[0].trim();

      if (ct === 'text/html' || ct === 'text/plain' || !ct || ct === 'application/xhtml+xml') {
        if (loadMsg) loadMsg.textContent = 'Rendering…';
        const html = await resp.text();
        if (!signal.aborted) bRenderHTML(html, finalUrl || url);

      } else if (ct === 'application/json' || ct.includes('json')) {
        const text = await resp.text();
        if (!signal.aborted) bRenderJSON(text);

      } else if (ct.startsWith('image/')) {
        const blob   = await resp.blob();
        const objUrl = URL.createObjectURL(blob);
        if (!signal.aborted && pageContent) {
          pageContent.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:200px;background:#111;padding:16px;">
            <img src="${objUrl}" style="max-width:100%;height:auto;border-radius:4px;">
          </div>`;
          bShowContent();
        }

      } else {
        const size = resp.headers.get('content-length') || '?';
        if (!signal.aborted && pageContent) {
          pageContent.innerHTML = `<div style="padding:24px;font-family:monospace;background:#0a0c0f;color:#e2e8f0;min-height:100%;">
            <h3 style="color:#22c55e;margin-bottom:8px;">Response received</h3>
            <p style="color:#64748b;">Content-Type: ${bEsc(ct)}</p>
            <p style="color:#64748b;">Size: ${size} bytes</p>
            <p style="margin-top:12px;color:#94a3b8;">This content type cannot be rendered inline.</p>
          </div>`;
          bShowContent();
        }
      }

    } catch (e) {
      if (e.name === 'AbortError') return; // FIX-B7: suppress abort errors
      if (loadOverlay) loadOverlay.style.display = 'none';
      if (errorPane)   errorPane.style.display   = 'flex';
      const errMsg = el('bErrorMsg');
      if (errMsg) errMsg.textContent = e.message + '\n\nMake sure the target is reachable.';
    }
  }

  // ── Render HTML ───────────────────────────────────────────────
  function bRenderHTML(html, baseUrl) {
    const pageContent = el('bPageContent');
    if (!pageContent) return;

    // ── FIX-B3: Rewrite all asset URLs to /proxy-asset?url=... ──
    // This runs server-side-style in a string before srcdoc injection.
    // Handles: src=, href= (stylesheets/scripts), action= forms,
    // srcset=, and inline CSS url().
    function rewriteUrl(u) {
      if (!u || !u.trim() || u.startsWith('data:') || u.startsWith('blob:') ||
          u.startsWith('javascript:') || u.startsWith('#') ||
          u.startsWith('mailto:') || u.startsWith('tel:')) return u;
      try {
        const abs = new URL(u.trim(), baseUrl).href;
        return '/proxy-asset?url=' + encodeURIComponent(abs);
      } catch (_) { return u; }
    }

    // Rewrite tag attributes
    let srcDoc = html
      // <script src="...">
      .replace(/(<script\b[^>]*\s)src=(["'])([^"']+)\2/gi, (m, pre, q, u) => `${pre}src=${q}${rewriteUrl(u)}${q}`)
      // <link href="...">
      .replace(/(<link\b[^>]*)href=(["'])([^"']+)\2/gi, (m, pre, q, u) => {
        // Don't rewrite canonical/alternate links — only stylesheet/icon
        if (/rel=(["'])(stylesheet|icon|shortcut)[^"']*\2/i.test(pre) || /type=(["'])text\/css\2/i.test(pre)) {
          return `${pre}href=${q}${rewriteUrl(u)}${q}`;
        }
        return m; // leave nav/canonical links for the interception script
      })
      // <img src="..."> <source src="..."> <audio src> <video src>
      .replace(/(<(?:img|source|audio|video|track|embed)\b[^>]*\s)src=(["'])([^"']+)\2/gi, (m, pre, q, u) => `${pre}src=${q}${rewriteUrl(u)}${q}`)
      // srcset="url 1x, url 2x"
      .replace(/srcset=(["'])([^"']+)\1/gi, (m, q, val) => {
        const rewritten = val.replace(/([^\s,]+)(\s+[\d.]+[wx])?/g, (sm, u, d) => rewriteUrl(u) + (d || ''));
        return `srcset=${q}${rewritten}${q}`;
      })
      // CSS url() inside style attributes and <style> blocks
      .replace(/url\((["']?)([^"')]+)\1\)/gi, (m, q, u) => `url(${q}${rewriteUrl(u)}${q})`);

    // FIX-B5: Remove ALL existing <base> tags, then inject one correct one
    srcDoc = srcDoc.replace(/<base\b[^>]*>/gi, '');
    const baseTag = `<base href="${baseUrl}">`;
    if (/<head\b[^>]*>/i.test(srcDoc)) {
      srcDoc = srcDoc.replace(/(<head\b[^>]*>)/i, '$1' + baseTag);
    } else if (/<html\b[^>]*>/i.test(srcDoc)) {
      srcDoc = srcDoc.replace(/(<html\b[^>]*>)/i, '$1<head>' + baseTag + '</head>');
    } else {
      srcDoc = baseTag + srcDoc;
    }

    // ── FIX-B4/B6: Interception script ──────────────────────────
    // Injected into EVERY page. Captures link clicks and form submits
    // via capture-phase listeners (fires before site's own handlers).
    // Uses postMessage to send nav/submit events to parent proxy UI.
    // FIX-B4: No allow-same-origin on the iframe, so we use '*' target.
    // FIX-B6: e.stopImmediatePropagation() prevents other site handlers
    //          from swallowing the event before we process it.
    const interceptScript = `<script>
(function() {
  var BASE = ${JSON.stringify(baseUrl)};
  function abs(u) { try { return new URL(u, BASE).href; } catch(_) { return u; } }

  // ── Link clicks ─────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    // Walk up the DOM to find the nearest anchor
    var el = e.target;
    for (var i = 0; i < 5 && el; i++) {
      if (el.tagName === 'A' && el.getAttribute('href')) break;
      el = el.parentElement;
    }
    if (!el || el.tagName !== 'A') return;
    var href = el.getAttribute('href');
    if (!href) return;
    // Let browser handle non-navigating hrefs
    if (href.startsWith('#') || href.startsWith('javascript:') ||
        href.startsWith('mailto:') || href.startsWith('tel:') ||
        href.startsWith('data:')) return;
    var target = el.getAttribute('target');
    if (target && target !== '_self' && target !== '_top' && target !== '_parent') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    window.parent.postMessage({ type: 'proxy-navigate', url: abs(href) }, '*');
  }, true); // capture phase — fires before site handlers

  // ── Form submits ─────────────────────────────────────────────
  document.addEventListener('submit', function(e) {
    var form   = e.target;
    var method = (form.getAttribute('method') || 'GET').toUpperCase();
    var action = abs(form.getAttribute('action') || location.href);
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (method === 'GET') {
      var qs = new URLSearchParams(new FormData(form)).toString();
      window.parent.postMessage({
        type: 'proxy-navigate',
        url: action + (qs ? (action.includes('?') ? '&' : '?') + qs : ''),
      }, '*');
    } else {
      window.parent.postMessage({
        type:        'proxy-submit',
        url:         action,
        method:      method,
        body:        new URLSearchParams(new FormData(form)).toString(),
        contentType: 'application/x-www-form-urlencoded',
      }, '*');
    }
  }, true);

  // ── XHR/fetch override — redirect in-page requests through proxy ─
  // Many SPAs use fetch/XHR for navigation. We patch them so requests
  // go through /proxy-asset which routes via proxy.js (captured).
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input.url || '');
    try {
      var absUrl = new URL(url, BASE).href;
      if (absUrl.startsWith('http') && !absUrl.startsWith(location.origin)) {
        var proxied = '/proxy-asset?url=' + encodeURIComponent(absUrl);
        return _origFetch(proxied, init);
      }
    } catch(_) {}
    return _origFetch(input, init);
  };

})();
<\/script>`;

    // Inject interception script before </body> or at the end
    if (/<\/body>/i.test(srcDoc)) {
      srcDoc = srcDoc.replace(/<\/body>/i, interceptScript + '</body>');
    } else {
      srcDoc += interceptScript;
    }

    // Clear old frame
    var old = pageContent.querySelector('iframe.proxy-frame');
    if (old) old.remove();

    // FIX-B4: Remove allow-same-origin — it caused postMessage mismatches.
    // Scripts still work (allow-scripts), forms work (allow-forms),
    // popups work (allow-popups). allow-same-origin is NOT included.
    var frame = document.createElement('iframe');
    frame.className = 'proxy-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals allow-presentation');
    frame.style.cssText = 'width:100%;height:100%;border:none;display:block;background:#fff;';
    frame.srcdoc = srcDoc;
    pageContent.style.cssText = 'display:block;width:100%;height:100%;padding:0;overflow:hidden;';
    pageContent.appendChild(frame);

    bShowContent();
  }

  function bRenderJSON(text) {
    const pageContent = el('bPageContent');
    if (!pageContent) return;
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
    pageContent.innerHTML = `<pre style="padding:16px;font-family:monospace;font-size:12px;background:#0a0c0f;color:#e2e8f0;white-space:pre-wrap;word-break:break-all;min-height:100%;">${bEsc(pretty)}</pre>`;
    bShowContent();
  }

  function bShowContent() {
    const loadOverlay = el('bLoadOverlay');
    const errorPane   = el('bErrorPane');
    const pageContent = el('bPageContent');
    const pageWrap    = el('bPageWrap');
    if (loadOverlay) loadOverlay.style.display = 'none';
    if (errorPane)   errorPane.style.display   = 'none';
    if (pageContent) pageContent.style.display = 'block';
    if (pageWrap)    pageWrap.scrollTop        = 0;
  }

  function bEsc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function bBumpCapture() {
    const dot = el('bCaptureDot');
    if (!dot) return;
    dot.style.background = '#f59e0b';
    setTimeout(() => { dot.style.background = '#22c55e'; }, 800);
  }

  async function bSyncStats() {
    try {
      const r = await fetch('/api/stats');
      const d = await r.json();
      const c = el('bCaptureCount');
      if (c && d.total !== undefined) c.textContent = d.total + ' captured';
    } catch (_) {}
  }
  setInterval(bSyncStats, 3000);
  bSyncStats();

})();
