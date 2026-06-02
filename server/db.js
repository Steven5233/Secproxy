/* ============================================================
   server/db.js — SQLite persistence layer
   Séç Proxy v2.0

   Uses sql.js (pure JavaScript SQLite — no native compilation,
   works perfectly on Termux without node-gyp).

   Data is saved to secproxy.db on every write via fs.writeFile.
   ============================================================ */
'use strict';

const path = require('path');
const fs   = require('fs');

const DB_PATH = path.join(__dirname, '..', 'secproxy.db');

// ── Load sql.js ──────────────────────────────────────────────
const initSqlJs = require('sql.js');

let db  = null;   // sql.js Database instance
let ready = false;

// Write DB to disk (called after every mutating operation)
function persist() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('[DB] persist error:', e.message);
  }
}

// ── Bootstrap ────────────────────────────────────────────────
async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
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
  `);

  persist();
  ready = true;
  console.log('[DB] sql.js database ready —', DB_PATH);
}

// ── Helper: run a single query and persist ───────────────────
function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

// ── Helper: return all rows as array of plain objects ─────────
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── Helper: return first row ─────────────────────────────────
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

// ── Helper: insert and return last insert id ──────────────────
function insert(sql, params = []) {
  db.run(sql, params);
  const row = get('SELECT last_insert_rowid() AS id');
  persist();
  return row ? row.id : null;
}

// ── Public API ────────────────────────────────────────────────
module.exports = {
  init,
  get ready() { return ready; },

  insertRequest(r) {
    return insert(
      `INSERT INTO requests (ts,method,scheme,host,port,path,url,req_headers,req_body)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [Date.now(), r.method||'GET', r.scheme||'http', r.host||'',
       r.port||80, r.path||'/', r.url||'',
       JSON.stringify(r.headers||{}), r.body||null]
    );
  },

  updateResponse(id, r) {
    run(
      `UPDATE requests SET res_status=?,res_headers=?,res_body=?,latency_ms=? WHERE id=?`,
      [r.status||null, JSON.stringify(r.headers||{}), r.body||null, r.latency_ms||null, id]
    );
  },

  getById(id) { return get(`SELECT * FROM requests WHERE id=?`, [id]); },

  list(n = 1000) {
    return all(
      `SELECT id,ts,method,scheme,host,port,path,url,req_headers,req_body,
              res_status,res_headers,res_body,latency_ms,flagged,tag
       FROM requests ORDER BY ts DESC LIMIT ?`, [n]
    );
  },

  search(q) {
    const w = `%${q}%`;
    return all(
      `SELECT id,ts,method,scheme,host,port,path,url,res_status,latency_ms,flagged,tag
       FROM requests WHERE host LIKE ? OR url LIKE ? OR CAST(res_status AS TEXT) LIKE ?
       ORDER BY ts DESC LIMIT 500`, [w, w, w]
    );
  },

  clearAll()      { run(`DELETE FROM requests`); run(`DELETE FROM scanner_hits`); },
  flagRequest(id) { run(`UPDATE requests SET flagged=1 WHERE id=?`, [id]); },

  addHit(h) {
    insert(
      `INSERT INTO scanner_hits(request_id,ts,severity,type,detail) VALUES(?,?,?,?,?)`,
      [h.request_id, Date.now(), h.severity, h.type, h.detail||'']
    );
    this.flagRequest(h.request_id);
  },

  hitsFor(id)   { return all(`SELECT * FROM scanner_hits WHERE request_id=?`, [id]); },

  saveRequest(o) {
    return insert(
      `INSERT INTO saved_requests(ts,name,folder,request_id,raw) VALUES(?,?,?,?,?)`,
      [Date.now(), o.name, o.folder||'Default', o.request_id||null, o.raw||'']
    );
  },

  listSaved()       { return all(`SELECT * FROM saved_requests ORDER BY folder,name`); },
  deleteSaved(id)   { run(`DELETE FROM saved_requests WHERE id=?`, [id]); },

  listRules()       { return all(`SELECT * FROM intercept_rules ORDER BY id`); },
  addRule(r)        { return insert(`INSERT INTO intercept_rules(enabled,field,op,value) VALUES(?,?,?,?)`, [r.enabled||1, r.field, r.op, r.value]); },
  deleteRule(id)    { run(`DELETE FROM intercept_rules WHERE id=?`, [id]); },

  listMR()          { return all(`SELECT * FROM match_replace_rules ORDER BY id`); },
  addMR(r)          { return insert(`INSERT INTO match_replace_rules(enabled,scope,field,match_str,replace,use_regex) VALUES(?,?,?,?,?,?)`, [r.enabled||1, r.scope, r.field, r.match_str, r.replace, r.use_regex||0]); },
  deleteMR(id)      { run(`DELETE FROM match_replace_rules WHERE id=?`, [id]); },

  close()           { if (db) { persist(); db.close(); } },
};
