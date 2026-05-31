/* ============================================================
   proxy-ui.js — Séç Proxy v2.0 Frontend
   Connects to the Node proxy server via REST + WebSocket.
   ============================================================ */

'use strict';

/* ── Config ─────────────────────────────────────────────── */
const API_BASE  = `http://${location.hostname}:8080`;
const WS_URL    = `ws://${location.hostname}:8081`;

/* ── State ───────────────────────────────────────────────── */
let historyRows       = [];    // raw request objects from server
let filteredRows      = [];
let selectedHistId    = null;
let interceptEnabled  = false;
let pendingIntercepts = {};    // id → request
let selectedIntId     = null;
let repBodyType       = 'json';
let repRespBody       = '';
let repRespHeaders    = '';
let repRespRaw        = '';
let repCurrentTab     = 'body';
let ws                = null;
let wsRetryTimer      = null;

/* ── WebSocket connection ────────────────────────────────── */
function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(WS_URL);
  const dot = document.getElementById('wsDot');

  ws.onopen = () => {
    dot.className = 'ws-dot connected';
    dot.title = 'WebSocket connected';
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    loadHistory();
    loadInterceptStatus();
    loadStats();
    loadProxyInfo();
  };

  ws.onclose = () => {
    dot.className = 'ws-dot disconnected';
    dot.title = 'WebSocket disconnected — retrying...';
    wsRetryTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = () => { ws.close(); };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleWSMessage(msg);
    } catch (_) {}
  };
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'request': {
      const row = msg.entry;
      historyRows.unshift(row);
      if (historyRows.length > 1000) historyRows.pop();
      applyFilters();
      document.getElementById('statTotal').textContent = historyRows.length + ' reqs';
      break;
    }
    case 'response': {
      const r = historyRows.find(x => x.id === msg.entry.id);
      if (r) Object.assign(r, msg.entry);
      applyFilters();
      if (selectedHistId === msg.entry.id) showDetail(msg.entry.id);
      break;
    }
    case 'intercepted': {
      pendingIntercepts[msg.id] = msg.request;
      renderInterceptQueue();
      updateInterceptBadge();
      showTab('intercept');
      break;
    }
    case 'intercept_resolved': {
      delete pendingIntercepts[msg.id];
      if (selectedIntId === msg.id) {
        selectedIntId = null;
        document.getElementById('interceptEditor').value = '';
      }
      renderInterceptQueue();
      updateInterceptBadge();
      break;
    }
    case 'scanner_hit': {
      loadScannerHits();
      break;
    }
    case 'stats': {
      updateStats(msg.stats);
      break;
    }
    case 'status': {
      if (msg.status && msg.status.intercept !== undefined) {
        interceptEnabled = msg.status.intercept;
        updateInterceptBtn();
      }
      break;
    }
  }
}

/* ── Tab switching ───────────────────────────────────────── */
document.querySelectorAll('.mtab').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function showTab(name) {
  document.querySelectorAll('.mtab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + name));
  if (name === 'settings')  { loadRules(); loadMRRules(); loadStats(); loadProxyInfo(); }
  if (name === 'scanner')   { loadScannerHits(); }
  if (name === 'intercept') { loadInterceptStatus(); }
}

/* ── REST helpers ────────────────────────────────────────── */
async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(API_BASE + path, opts);
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

/* ── History loading ─────────────────────────────────────── */
async function loadHistory() {
  const rows = await api('/api/requests');
  if (Array.isArray(rows)) {
    historyRows = rows;
    applyFilters();
    document.getElementById('statTotal').textContent = rows.length + ' reqs';
  }
}

function applyFilters() {
  const q   = (document.getElementById('histSearch').value || '').toLowerCase();
  const m   = document.getElementById('methodFilter').value;
  const s   = document.getElementById('statusFilter').value;

  filteredRows = historyRows.filter(r => {
    if (m && r.method !== m) return false;
    if (s && !String(r.res_status || '').startsWith(s)) return false;
    if (q) {
      const hay = ((r.host || '') + (r.url || '') + (r.res_status || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  renderHistTable();
}

function searchHistory(q) { applyFilters(); }

function renderHistTable() {
  const tbody = document.getElementById('histBody');
  tbody.innerHTML = '';
  const mc = { GET:'var(--method-get)', POST:'var(--method-post)', PUT:'var(--method-put)', DELETE:'var(--method-delete)', PATCH:'var(--method-patch)' };

  filteredRows.forEach(r => {
    const tr = document.createElement('tr');
    if (r.flagged) tr.classList.add('flagged');
    if (r.id === selectedHistId) tr.classList.add('selected');

    const st  = r.res_status || '';
    const sc  = st ? (st >= 500 ? 's5' : st >= 400 ? 's4' : st >= 300 ? 's3' : 's2') : '';
    const len = r.res_body ? fmtSize(r.res_body.length || 0) : '—';
    const pathShort = (r.path || '/').slice(0, 60);
    const hostShort = (r.host || '').replace(/^www\./, '');

    tr.innerHTML = `
      <td>${r.id}</td>
      <td class="method-cell" style="color:${mc[r.method]||'var(--text2)'}">${r.method}</td>
      <td title="${escHTML(r.host || '')}">${escHTML(hostShort)}</td>
      <td title="${escHTML(r.path || '')}">${escHTML(pathShort)}</td>
      <td class="${sc}">${st || '—'}</td>
      <td>${len}</td>
      <td>${r.latency_ms != null ? r.latency_ms : '—'}</td>
      <td><button class="rep-icon" title="Send to Repeater" onclick="sendToRepeaterFromHist(${r.id},event)">&#x21BA;</button></td>
    `;
    tr.onclick = (e) => { if (e.target.classList.contains('rep-icon')) return; selectHistRow(r.id, tr); };
    tbody.appendChild(tr);
  });
}

async function selectHistRow(id, tr) {
  document.querySelectorAll('#histBody tr').forEach(r => r.classList.remove('selected'));
  if (tr) tr.classList.add('selected');
  selectedHistId = id;
  await showDetail(id);
}

async function showDetail(id) {
  const r = await api(`/api/requests/${id}`);
  if (r.error) return;

  const panel = document.getElementById('histDetail');
  const reqH  = safeParse(r.req_headers, {});
  const resH  = safeParse(r.res_headers, {});

  panel.innerHTML = `
    <div class="detail-tabs">
      <button class="dtab active" onclick="switchDTab(this,'req')">Request</button>
      <button class="dtab" onclick="switchDTab(this,'res')">Response</button>
      <button class="dtab" onclick="switchDTab(this,'raw')">Raw</button>
      ${r.scanner_hits && r.scanner_hits.length ? `<button class="dtab" onclick="switchDTab(this,'hits')">Hits (${r.scanner_hits.length})</button>` : ''}
    </div>
    <div class="detail-body" id="detailBody">
      <div id="dtab-req">
        <table class="detail-kv-table">
          <tr><td>Method</td><td>${r.method}</td></tr>
          <tr><td>URL</td><td style="word-break:break-all">${escHTML(r.url)}</td></tr>
          ${Object.entries(reqH).map(([k,v])=>`<tr><td>${escHTML(k)}</td><td>${escHTML(String(v))}</td></tr>`).join('')}
        </table>
        ${r.req_body ? `<pre class="resp-body" style="max-height:200px;overflow:auto">${colorizeJSON(r.req_body)}</pre>` : ''}
      </div>
      <div id="dtab-res" style="display:none">
        <table class="detail-kv-table">
          <tr><td>Status</td><td>${r.res_status || '—'}</td></tr>
          <tr><td>Latency</td><td>${r.latency_ms != null ? r.latency_ms+'ms' : '—'}</td></tr>
          ${Object.entries(resH).map(([k,v])=>`<tr><td>${escHTML(k)}</td><td>${escHTML(String(v))}</td></tr>`).join('')}
        </table>
        ${r.res_body ? `<pre class="resp-body" style="max-height:300px;overflow:auto">${colorizeJSON(r.res_body)}</pre>` : ''}
      </div>
      <div id="dtab-raw" style="display:none">
        <pre class="resp-body" style="overflow:auto">${escHTML(buildRaw(r))}</pre>
      </div>
      ${r.scanner_hits && r.scanner_hits.length ? `
      <div id="dtab-hits" style="display:none;padding:10px">
        ${r.scanner_hits.map(h => buildHitCard(h, r.url)).join('')}
      </div>` : ''}
    </div>
    <div class="detail-send-rep">
      <button class="send-btn" onclick="sendToRepeaterFromHist(${r.id})">&#x21BA; Send to Repeater</button>
      <button class="tbtn" onclick="copyRaw(${r.id})">Copy Raw</button>
    </div>
  `;
}

function switchDTab(btn, name) {
  btn.closest('.detail-tabs').querySelectorAll('.dtab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const body = document.getElementById('detailBody');
  body.querySelectorAll('[id^=dtab-]').forEach(el => el.style.display = 'none');
  const el = document.getElementById('dtab-' + name);
  if (el) el.style.display = '';
}

function buildRaw(r) {
  const reqH = safeParse(r.req_headers, {});
  const resH = safeParse(r.res_headers, {});
  const reqPart = `${r.method} ${r.path} HTTP/1.1\r\n` +
    Object.entries(reqH).map(([k,v]) => `${k}: ${v}`).join('\r\n') +
    `\r\n\r\n${r.req_body || ''}`;
  const resPart = r.res_status
    ? `HTTP/1.1 ${r.res_status}\r\n` +
      Object.entries(resH).map(([k,v]) => `${k}: ${v}`).join('\r\n') +
      `\r\n\r\n${r.res_body || ''}`
    : '(no response yet)';
  return `=== REQUEST ===\n${reqPart}\n\n=== RESPONSE ===\n${resPart}`;
}

async function copyRaw(id) {
  const r = await api(`/api/requests/${id}`);
  if (!r.error) navigator.clipboard?.writeText(buildRaw(r)).then(() => flash('Copied!'));
}

async function clearHistory() {
  if (!confirm('Clear all captured requests?')) return;
  await api('/api/requests/clear', 'POST');
  historyRows = [];
  filteredRows = [];
  renderHistTable();
  document.getElementById('histDetail').innerHTML = `<div class="detail-empty"><div style="font-size:32px;opacity:.15">&#x2B21;</div><p>Select a request to inspect</p></div>`;
  document.getElementById('statTotal').textContent = '0 reqs';
}

function exportHAR() {
  const entries = filteredRows.map(r => {
    const reqH = safeParse(r.req_headers, {});
    const resH = safeParse(r.res_headers, {});
    return {
      startedDateTime: new Date(r.ts).toISOString(),
      time: r.latency_ms || 0,
      request: {
        method: r.method, url: r.url, httpVersion: 'HTTP/1.1',
        headers: Object.entries(reqH).map(([n,v]) => ({name:n, value:String(v)})),
        queryString: [], cookies: [], headersSize: -1,
        bodySize: (r.req_body || '').length,
        postData: r.req_body ? { mimeType: reqH['content-type']||'', text: r.req_body } : undefined,
      },
      response: {
        status: r.res_status || 0, statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(resH).map(([n,v]) => ({name:n, value:String(v)})),
        cookies: [], redirectURL: '',
        headersSize: -1, bodySize: (r.res_body||'').length,
        content: { size: (r.res_body||'').length, mimeType: resH['content-type']||'', text: r.res_body||'' },
      },
      cache: {}, timings: { send:0, wait: r.latency_ms||0, receive:0 },
    };
  });
  const har = { log: { version:'1.2', creator:{name:'Séç Proxy',version:'2.0'}, entries } };
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `secproxy-${Date.now()}.har`;
  a.click();
}

/* ── Intercept ───────────────────────────────────────────── */
async function loadInterceptStatus() {
  const r = await api('/api/intercept/status');
  if (r.error) return;
  interceptEnabled = r.enabled;
  updateInterceptBtn();
  if (r.pending) {
    r.pending.forEach(p => { pendingIntercepts[p.id] = p; });
    renderInterceptQueue();
    updateInterceptBadge();
  }
}

async function toggleIntercept() {
  const r = await api('/api/intercept/toggle', 'POST');
  if (!r.error) {
    interceptEnabled = r.enabled;
    updateInterceptBtn();
    flash(r.enabled ? 'Intercept ON' : 'Intercept OFF');
  }
}

function updateInterceptBtn() {
  const btn = document.getElementById('interceptToggle');
  btn.textContent = interceptEnabled ? 'Intercept ON' : 'Intercept OFF';
  btn.classList.toggle('on', interceptEnabled);
}

function renderInterceptQueue() {
  const queue = document.getElementById('interceptQueue');
  const items = Object.entries(pendingIntercepts);
  if (!items.length) {
    queue.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px;text-align:center">No intercepted requests</div>`;
    document.getElementById('pendingCount').textContent = '0';
    return;
  }
  document.getElementById('pendingCount').textContent = items.length;
  const mc = { GET:'var(--method-get)', POST:'var(--method-post)', PUT:'var(--method-put)', DELETE:'var(--method-delete)', PATCH:'var(--method-patch)' };

  queue.innerHTML = items.map(([id, req]) => `
    <div class="queue-item ${selectedIntId == id ? 'active' : ''}" onclick="selectIntercept(${id})">
      <div class="queue-method" style="color:${mc[req.method]||'var(--text2)'}">
        ${req.method}
        <span style="color:var(--text3);font-weight:400">${req.host||''}</span>
      </div>
      <div class="queue-url">${escHTML(req.url||req.path||'')}</div>
    </div>
  `).join('');
}

function updateInterceptBadge() {
  const n = Object.keys(pendingIntercepts).length;
  const badge = document.getElementById('interceptBadge');
  badge.textContent = n;
  badge.style.display = n ? '' : 'none';
}

function selectIntercept(id) {
  selectedIntId = id;
  const req = pendingIntercepts[id];
  if (!req) return;

  const reqH = req.headers || {};
  const raw = `${req.method} ${req.path || '/'} HTTP/1.1\r\n` +
    Object.entries(reqH).map(([k,v]) => `${k}: ${v}`).join('\r\n') +
    `\r\n\r\n${req.body || ''}`;

  document.getElementById('interceptEditor').value = raw;
  renderInterceptQueue();
}

function parseRawRequest(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  const headerPart = idx >= 0 ? raw.slice(0, idx) : raw;
  const body       = idx >= 0 ? raw.slice(idx + 4) : '';
  const lines   = headerPart.split('\r\n');
  const reqLine = lines[0] || '';
  const parts   = reqLine.split(' ');
  const method  = parts[0] || 'GET';
  const path    = parts[1] || '/';
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    headers[lines[i].slice(0,c).trim()] = lines[i].slice(c+1).trim();
  }
  return { method, path, headers, body };
}

async function forwardCurrent() {
  if (!selectedIntId) return flash('Select a request first');
  const raw     = document.getElementById('interceptEditor').value;
  const parsed  = parseRawRequest(raw);
  const orig    = pendingIntercepts[selectedIntId] || {};
  const request = { ...orig, ...parsed };
  await api('/api/intercept/forward', 'POST', { id: selectedIntId, request });
}

async function dropCurrent() {
  if (!selectedIntId) return flash('Select a request first');
  await api('/api/intercept/drop', 'POST', { id: selectedIntId });
}

async function forwardAll() {
  await api('/api/intercept/forward-all', 'POST');
}

function switchETab(btn, name) {
  btn.closest('.editor-tabs').querySelectorAll('.etab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

/* ── Repeater ────────────────────────────────────────────── */
function updateRepMethodColor() {
  const s = document.getElementById('repMethod');
  const mc = { GET:'var(--method-get)', POST:'var(--method-post)', PUT:'var(--method-put)', DELETE:'var(--method-delete)', PATCH:'var(--method-patch)' };
  s.style.color = mc[s.value] || 'var(--text)';
}
updateRepMethodColor();

async function repeatSend() {
  const url = document.getElementById('repUrl').value.trim();
  if (!url) return flash('Enter a URL');

  const method  = document.getElementById('repMethod').value;
  const headers = {};
  getKVRows('repHeadersTable').forEach(h => { headers[h.k] = h.v; });

  const cookieRows = getKVRows('repCookiesTable');
  if (cookieRows.length) headers['Cookie'] = cookieRows.map(c => `${c.k}=${c.v}`).join('; ');

  let finalUrl = url;
  const params = getKVRows('repParamsTable');
  if (params.length) {
    const base = url.split('?')[0];
    finalUrl = base + '?' + params.map(p => encodeURIComponent(p.k) + '=' + encodeURIComponent(p.v)).join('&');
  }

  const body = repBodyType === 'none' ? undefined : document.getElementById('repBody').value || undefined;
  if (repBodyType === 'form') headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const btn = document.getElementById('repSendBtn');
  btn.textContent = '...';

  document.getElementById('repRespEmpty').style.display = 'none';
  document.getElementById('repRespLoading').style.display = 'flex';
  document.getElementById('repRespBody').style.display = 'none';
  document.getElementById('repRespTopbar').style.visibility = 'hidden';

  const res = await api('/api/repeat', 'POST', { method, url: finalUrl, headers, body });

  btn.textContent = 'Send';
  document.getElementById('repRespLoading').style.display = 'none';
  document.getElementById('repRespTopbar').style.visibility = 'visible';

  const badge = document.getElementById('repStatusBadge');
  badge.textContent = `${res.status}`;
  badge.className = 'status-badge';
  const s = res.status;
  if (s >= 500) badge.classList.add('status-5xx');
  else if (s >= 400) badge.classList.add('status-4xx');
  else if (s >= 300) badge.classList.add('status-3xx');
  else badge.classList.add('status-2xx');

  document.getElementById('repRespMeta').innerHTML = `<b>${res.latency}ms</b> · <b>${fmtSize((res.body||'').length)}</b>`;

  repRespHeaders = Object.entries(res.headers||{})
    .map(([k,v]) => `<span style="color:var(--info)">${escHTML(k)}</span>: <span style="color:var(--warn)">${escHTML(String(v))}</span>`)
    .join('\n');
  repRespRaw = `HTTP/1.1 ${res.status}\n` + Object.entries(res.headers||{}).map(([k,v])=>`${k}: ${v}`).join('\n') + '\n\n' + (res.body||'');
  repRespBody = colorizeJSON(res.body || '');

  showRepRespTab(repCurrentTab);
  document.getElementById('repRespBody').style.display = '';
}

function switchRepRespTab(btn, tab) {
  document.querySelectorAll('.resp-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  repCurrentTab = tab;
  showRepRespTab(tab);
}

function showRepRespTab(tab) {
  const el = document.getElementById('repRespBody');
  if (tab === 'body')    el.innerHTML = repRespBody;
  else if (tab === 'headers') el.innerHTML = repRespHeaders;
  else el.innerHTML = escHTML(repRespRaw);
}

function copyRepResp() {
  navigator.clipboard?.writeText(repRespRaw).then(() => flash('Copied!'));
}

function setRepBodyType(btn, type) {
  document.querySelectorAll('[onclick^="setRepBodyType"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  repBodyType = type;
}

function prettyRepJSON() {
  const ta = document.getElementById('repBody');
  try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (_) {}
}

async function sendToRepeaterFromHist(id, e) {
  if (e) e.stopPropagation();
  const r = await api(`/api/requests/${id}`);
  if (r.error) return;

  document.getElementById('repUrl').value    = r.url || '';
  document.getElementById('repMethod').value = r.method || 'GET';
  updateRepMethodColor();

  const table = document.getElementById('repHeadersTable');
  table.innerHTML = '';
  const headers = safeParse(r.req_headers, {});
  Object.entries(headers).forEach(([k,v]) => addKVRow('repHeadersTable', 'rep-headers', k, v));

  if (r.req_body) {
    document.getElementById('repBody').value = r.req_body;
  }

  showTab('repeater');
  flash('Loaded into Repeater');
}

/* ── Decoder ─────────────────────────────────────────────── */
function runDecode() {
  const op  = document.getElementById('decodeOp').value;
  const inp = document.getElementById('decodeInput').value;
  let out = '';
  try {
    switch (op) {
      case 'b64-decode':  out = atob(inp.trim()); break;
      case 'b64-encode':  out = btoa(inp); break;
      case 'url-decode':  out = decodeURIComponent(inp); break;
      case 'url-encode':  out = encodeURIComponent(inp); break;
      case 'html-decode': { const t = document.createElement('textarea'); t.innerHTML = inp; out = t.value; break; }
      case 'html-encode': out = inp.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); break;
      case 'hex-decode':  out = inp.replace(/\s/g,'').match(/.{1,2}/g).map(b => String.fromCharCode(parseInt(b,16))).join(''); break;
      case 'hex-encode':  out = [...inp].map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' '); break;
      case 'jwt-decode': {
        const parts = inp.split('.');
        const header  = JSON.parse(atob(parts[0]||''));
        const payload = JSON.parse(atob((parts[1]||'').replace(/-/g,'+').replace(/_/g,'/')));
        out = `=== HEADER ===\n${JSON.stringify(header,null,2)}\n\n=== PAYLOAD ===\n${JSON.stringify(payload,null,2)}\n\n=== SIGNATURE ===\n${parts[2]||''}`;
        break;
      }
      case 'json-format': out = JSON.stringify(JSON.parse(inp), null, 2); break;
      case 'hash-sha256': {
        const msgBuf = new TextEncoder().encode(inp);
        window.crypto.subtle.digest('SHA-256', msgBuf).then(buf => {
          const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
          document.getElementById('decodeOutput').textContent = hex;
        });
        return;
      }
      default: out = inp;
    }
  } catch (e) { out = 'Error: ' + e.message; }
  document.getElementById('decodeOutput').textContent = out;
}

function swapDecoder() {
  const inp = document.getElementById('decodeInput');
  const out = document.getElementById('decodeOutput');
  inp.value = out.textContent;
  out.textContent = '';
}

function copyDecoded() {
  navigator.clipboard?.writeText(document.getElementById('decodeOutput').textContent).then(() => flash('Copied!'));
}

function sendDecodedToRepeater() {
  const val = document.getElementById('decodeOutput').textContent;
  document.getElementById('repBody').value = val;
  showTab('repeater');
  flash('Sent to Repeater body');
}

/* ── Scanner ─────────────────────────────────────────────── */
async function loadScannerHits() {
  const rows = await api('/api/requests');
  if (!Array.isArray(rows)) return;

  const flagged = rows.filter(r => r.flagged);
  document.getElementById('scannerCount').textContent = flagged.length;

  if (!flagged.length) {
    document.getElementById('scannerHits').innerHTML = `<p style="color:var(--text3);font-size:12px;margin-top:8px;text-align:center">No scanner hits yet.</p>`;
    return;
  }

  const container = document.getElementById('scannerHits');
  container.innerHTML = '';
  for (const r of flagged) {
    const full = await api(`/api/requests/${r.id}`);
    if (!full.scanner_hits || !full.scanner_hits.length) continue;
    full.scanner_hits.forEach(h => {
      container.innerHTML += buildHitCard(h, r.url);
    });
  }
}

function buildHitCard(h, url) {
  const sevClass = { info:'sev-info', low:'sev-low', medium:'sev-medium', high:'sev-high' }[h.severity] || 'sev-info';
  return `<div class="hit-card">
    <div class="hit-header">
      <span class="hit-severity ${sevClass}">${h.severity}</span>
      <span class="hit-type">${escHTML(h.type)}</span>
    </div>
    <div class="hit-detail">${escHTML(h.detail)}</div>
    ${url ? `<div class="hit-url">${escHTML(url)}</div>` : ''}
  </div>`;
}

/* ── Settings — rules ────────────────────────────────────── */
async function loadRules() {
  const rules = await api('/api/rules');
  if (!Array.isArray(rules)) return;
  const el = document.getElementById('rulesList');
  el.innerHTML = rules.map(r =>
    `<div class="rule-item">
      <span style="color:var(--info)">${r.field}</span>
      <span style="color:var(--text3)">${r.op}</span>
      <span>${escHTML(r.value)}</span>
      <button class="rule-del" onclick="deleteRule(${r.id})">×</button>
    </div>`
  ).join('') || `<p style="font-size:11px;color:var(--text3);margin:4px 0">No rules — intercepting all traffic</p>`;
}

async function addRule() {
  const field = document.getElementById('newRuleField').value;
  const op    = document.getElementById('newRuleOp').value;
  const value = document.getElementById('newRuleVal').value.trim();
  if (!value) return flash('Enter a rule value');
  await api('/api/rules', 'POST', { enabled: 1, field, op, value });
  document.getElementById('newRuleVal').value = '';
  loadRules();
}

async function deleteRule(id) {
  await api(`/api/rules/${id}`, 'DELETE');
  loadRules();
}

async function loadMRRules() {
  const rules = await api('/api/mr-rules');
  if (!Array.isArray(rules)) return;
  const el = document.getElementById('mrRulesList');
  el.innerHTML = rules.map(r =>
    `<div class="rule-item">
      <span style="color:var(--warn)">${r.scope}</span>
      <span style="color:var(--info)">${r.field}</span>
      <span>${escHTML(r.match)}</span>
      <span style="color:var(--text3)">→</span>
      <span>${escHTML(r.replace)}</span>
      <button class="rule-del" onclick="deleteMRRule(${r.id})">×</button>
    </div>`
  ).join('') || `<p style="font-size:11px;color:var(--text3);margin:4px 0">No rules</p>`;
}

async function addMRRule() {
  const scope   = document.getElementById('mrScope').value;
  const field   = document.getElementById('mrField').value;
  const match   = document.getElementById('mrMatch').value.trim();
  const replace = document.getElementById('mrReplace').value;
  if (!match) return flash('Enter a match pattern');
  await api('/api/mr-rules', 'POST', { enabled: 1, scope, field, match, replace, use_regex: 0 });
  document.getElementById('mrMatch').value = '';
  document.getElementById('mrReplace').value = '';
  loadMRRules();
}

async function deleteMRRule(id) {
  await api(`/api/mr-rules/${id}`, 'DELETE');
  loadMRRules();
}

/* ── Stats & Proxy Info ──────────────────────────────────── */
async function loadStats() {
  const s = await api('/api/stats');
  if (s.error) return;
  updateStats(s);
}

function updateStats(s) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('sTot', s.total || 0);
  set('sInt', s.intercepted || 0);
  set('sErr', s.errors || 0);
  set('sBin',  fmtSize(s.bytesIn  || 0));
  set('sBout', fmtSize(s.bytesOut || 0));
  set('sUp',   fmtUptime(s.uptime || 0));
  set('statTotal', (s.total || 0) + ' reqs');
}

async function loadProxyInfo() {
  const info = await api('/api/info');
  if (info.error) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('infoHost', info.proxyHost);
  set('infoPort', info.proxyPort);
  set('infoWS',   info.wsPort);
}

/* ── KV table helpers (from original app.js) ─────────────── */
const KEY_COLORS = {
  'rep-headers': 'var(--info)',
  'rep-params':  'var(--warn)',
  'rep-cookies': 'var(--method-post)',
};

function addKVRow(tableId, key, k = '', v = '', enabled = true) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const row = document.createElement('div');
  row.className = 'kv-row';

  const cb = document.createElement('div');
  cb.className = 'kv-check';
  cb.innerHTML = `<input type="checkbox" ${enabled ? 'checked' : ''} onchange="updateKVCount('${key}')">`;

  const kInput = document.createElement('input');
  kInput.className = 'kv-key';
  kInput.placeholder = 'Key';
  kInput.value = k;
  kInput.style.color = KEY_COLORS[key] || 'var(--info)';

  const vInput = document.createElement('input');
  vInput.className = 'kv-val';
  vInput.placeholder = 'Value';
  vInput.value = v;

  const del = document.createElement('div');
  del.className = 'kv-del';
  const btn = document.createElement('button');
  btn.textContent = '×';
  btn.onclick = () => { row.remove(); updateKVCount(key); };
  del.appendChild(btn);

  row.append(cb, kInput, vInput, del);
  table.appendChild(row);
  updateKVCount(key);
}

function getKVRows(tableId) {
  const rows = [];
  const table = document.getElementById(tableId);
  if (!table) return rows;
  table.querySelectorAll('.kv-row').forEach(row => {
    const cb  = row.querySelector('input[type=checkbox]');
    const ins = row.querySelectorAll('input.kv-key, input.kv-val');
    const k   = ins[0]?.value || '';
    const v   = ins[1]?.value || '';
    if (k && cb?.checked) rows.push({ k, v });
  });
  return rows;
}

function updateKVCount(key) {
  const table = document.getElementById(key.replace('-', '') === key ? key + 'Table' : key.replace(/-/g,'') + 'Table');
  const mapping = { 'rep-headers': 'repHeadersTable', 'rep-params': 'repParamsTable', 'rep-cookies': 'repCookiesTable' };
  const tbl = document.getElementById(mapping[key] || key + 'Table');
  if (!tbl) return;
  const n  = tbl.querySelectorAll('input[type=checkbox]:checked').length;
  const el = document.getElementById(key + '-count');
  if (el) el.textContent = n;
}

function toggleSection(id) {
  const el  = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

/* ── Utilities ───────────────────────────────────────────── */
function escHTML(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function colorizeJSON(raw) {
  if (!raw) return '';
  let formatted = raw;
  try { formatted = JSON.stringify(JSON.parse(raw), null, 2); } catch (_) {}
  return escHTML(formatted).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    match => {
      if (/^&quot;/.test(match)) {
        if (/:$/.test(match)) return `<span class="json-key">${match}</span>`;
        return `<span class="json-str">${match}</span>`;
      }
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
      if (/null/.test(match))       return `<span class="json-null">${match}</span>`;
      return `<span class="json-num">${match}</span>`;
    }
  );
}

function fmtSize(n) {
  if (n < 1024)     return n + ' B';
  if (n < 1048576)  return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}

function safeParse(str, fallback) {
  if (!str) return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function flash(msg) {
  const el = document.createElement('div');
  el.className = 'flash-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

/* ── Init ────────────────────────────────────────────────── */
addKVRow('repHeadersTable', 'rep-headers', 'Content-Type', 'application/json');
addKVRow('repHeadersTable', 'rep-headers', 'Accept', '*/*');
connectWS();
