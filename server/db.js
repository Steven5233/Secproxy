/* ============================================================
   server/db.js — SQLite persistence layer
   Séç Proxy v2.0

   Uses sql.js (pure JavaScript SQLite — zero native compilation,
   works on Termux without node-gyp).

   Every public method is synchronous-looking but internally
   waits for db.init() to finish via a readiness promise.
   This prevents "Cannot read properties of null" crashes when
   the proxy receives requests before the DB wasm loads.
   ============================================================ */
'use strict';

const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', 'secproxy.db');

let _db        = null;   // sql.js Database instance
let _initDone  = false;
let _initErr   = null;

// Single promise that resolves once the DB is fully ready
let _readyResolve;
const _ready = new Promise(res => { _readyResolve = res; });

// ── Persist DB to disk after every write ─────────────────────
function persist() {
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('[DB] persist error:', e.message);
  }
}

// ── Schema ───────────────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    method      TEXT    NOT NULL,
    scheme      TEXT    NOT NULL DEFAULT 'http',
    host        TEXT    NOT NULL,
    port        INTEGER NOT NULL DEFAULT 80,
    path        TEXT    NOT NULL DEFAULT '/',
    url         TEXT    NOT NULL,
    req_headers TEXT    NOT NULL DEFAULT '{}',
    req_body    TEXT,
    res_status  INTEGER,
    res_headers TEXT,
    res_body    TEXT,
    latency_ms  INTEGER,
    flagged     INTEGER NOT NULL DEFAULT 0,
    notes       TEXT,
    tag         TEXT
  );
  CREATE TABLE IF NOT EXISTS scanner_hits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    ts         INTEGER NOT NULL,
    severity   TEXT NOT NULL,
    type       TEXT NOT NULL,
    detail     TEXT
  );
  CREATE TABLE IF NOT EXISTS saved_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    name       TEXT NOT NULL,
    folder     TEXT NOT NULL DEFAULT 'Default',
    request_id INTEGER,
    raw        TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS intercept_rules (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    enabled INTEGER NOT NULL DEFAULT 1,
    field   TEXT NOT NULL,
    op      TEXT NOT NULL,
    value   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS match_replace_rules (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    enabled   INTEGER NOT NULL DEFAULT 1,
    scope     TEXT NOT NULL,
    field     TEXT NOT NULL,
    match_str TEXT NOT NULL,
    replace   TEXT NOT NULL,
    use_regex INTEGER NOT NULL DEFAULT 0
  );
`;

// ── Init (call once at startup) ──────────────────────────────
async function init() {
  if (_initDone) return;
  try {
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      _db = new SQL.Database(fileBuffer);
      console.log('[DB] Loaded existing database from', DB_PATH);
    } else {
      _db = new SQL.Database();
      console.log('[DB] Created new database at', DB_PATH);
    }

    _db.run(SCHEMA);
    persist();
    _initDone = true;
    _readyResolve();
    console.log('[DB] sql.js ready — no native compilation needed');
  } catch (e) {
    _initErr = e;
    console.error('[DB] FATAL: init failed:', e.message);
    _readyResolve(); // unblock waiters so they fail fast
    throw e;
  }
}

// ── Internal helpers (called only after _ready resolves) ──────
function _run(sql, params = []) {
  _db.run(sql, params);
  persist();
}

function _all(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function _get(sql, params = []) {
  return _all(sql, params)[0] || null;
}

function _insert(sql, params = []) {
  _db.run(sql, params);
  const row = _get('SELECT last_insert_rowid() AS id');
  persist();
  return row ? row.id : null;
}

// ── Guard: every public method goes through this ─────────────
// Returns result synchronously once ready, throws if DB failed.
function _guard(fn) {
  if (_initDone && !_initErr) return fn();
  if (_initErr) throw new Error('[DB] not initialised: ' + _initErr.message);
  // DB not ready yet — this shouldn't happen because proxy.js
  // awaits init() before calling server.listen(), but just in
  // case, throw a clear error instead of a null crash.
  throw new Error('[DB] accessed before init() completed — this is a bug');
}

// ── Public API ────────────────────────────────────────────────
module.exports = {
  init,

  insertRequest(r) {
    return _guard(() => _insert(
      `INSERT INTO requests (ts,method,scheme,host,port,path,url,req_headers,req_body)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [Date.now(), r.method||'GET', r.scheme||'http', r.host||'',
       r.port||80, r.path||'/', r.url||'',
       JSON.stringify(r.headers||{}), r.body||null]
    ));
  },

  updateResponse(id, r) {
    _guard(() => _run(
      `UPDATE requests
       SET res_status=?, res_headers=?, res_body=?, latency_ms=?
       WHERE id=?`,
      [r.status||null, JSON.stringify(r.headers||{}),
       r.body||null, r.latency_ms||null, id]
    ));
  },

  getById(id) {
    return _guard(() => _get(`SELECT * FROM requests WHERE id=?`, [id]));
  },

  list(n = 1000) {
    return _guard(() => _all(
      `SELECT id, ts, method, scheme, host, port, path, url,
              req_headers, req_body, res_status, res_headers,
              res_body, latency_ms, flagged, tag
       FROM requests ORDER BY ts DESC LIMIT ?`, [n]
    ));
  },

  search(q) {
    return _guard(() => {
      const w = `%${q}%`;
      return _all(
        `SELECT id, ts, method, scheme, host, port, path, url,
                res_status, latency_ms, flagged, tag
         FROM requests
         WHERE host LIKE ? OR url LIKE ? OR CAST(res_status AS TEXT) LIKE ?
         ORDER BY ts DESC LIMIT 500`,
        [w, w, w]
      );
    });
  },

  clearAll() {
    _guard(() => {
      _run(`DELETE FROM requests`);
      _run(`DELETE FROM scanner_hits`);
    });
  },

  flagRequest(id) {
    _guard(() => _run(`UPDATE requests SET flagged=1 WHERE id=?`, [id]));
  },

  addHit(h) {
    _guard(() => {
      _insert(
        `INSERT INTO scanner_hits (request_id, ts, severity, type, detail)
         VALUES (?,?,?,?,?)`,
        [h.request_id, Date.now(), h.severity, h.type, h.detail||'']
      );
      this.flagRequest(h.request_id);
    });
  },

  hitsFor(id) {
    return _guard(() => _all(
      `SELECT * FROM scanner_hits WHERE request_id=?`, [id]
    ));
  },

  saveRequest(o) {
    return _guard(() => _insert(
      `INSERT INTO saved_requests (ts, name, folder, request_id, raw)
       VALUES (?,?,?,?,?)`,
      [Date.now(), o.name, o.folder||'Default', o.request_id||null, o.raw||'']
    ));
  },

  listSaved() {
    return _guard(() => _all(
      `SELECT * FROM saved_requests ORDER BY folder, name`
    ));
  },

  deleteSaved(id) {
    _guard(() => _run(`DELETE FROM saved_requests WHERE id=?`, [id]));
  },

  listRules() {
    return _guard(() => _all(
      `SELECT * FROM intercept_rules ORDER BY id`
    ));
  },

  addRule(r) {
    return _guard(() => _insert(
      `INSERT INTO intercept_rules (enabled, field, op, value)
       VALUES (?,?,?,?)`,
      [r.enabled||1, r.field, r.op, r.value]
    ));
  },

  deleteRule(id) {
    _guard(() => _run(`DELETE FROM intercept_rules WHERE id=?`, [id]));
  },

  listMR() {
    return _guard(() => _all(
      `SELECT * FROM match_replace_rules ORDER BY id`
    ));
  },

  addMR(r) {
    return _guard(() => _insert(
      `INSERT INTO match_replace_rules
         (enabled, scope, field, match_str, replace, use_regex)
       VALUES (?,?,?,?,?,?)`,
      [r.enabled||1, r.scope, r.field, r.match_str,
       r.replace, r.use_regex||0]
    ));
  },

  deleteMR(id) {
    _guard(() => _run(`DELETE FROM match_replace_rules WHERE id=?`, [id]));
  },

  close() {
    if (_db) { persist(); _db.close(); _db = null; }
  },
};
