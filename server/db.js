/* ============================================================
   db.js — SQLite request/response store
   Séç Proxy v2.0
   ============================================================ */

'use strict';

const path    = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'secproxy.db');
const db      = new Database(DB_PATH);

/* ── Schema ─────────────────────────────────────────────── */
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous  = NORMAL;

  CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,          -- unix ms
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
    flagged     INTEGER NOT NULL DEFAULT 0, -- 1 = scanner hit
    notes       TEXT,
    tag         TEXT
  );

  CREATE TABLE IF NOT EXISTS scanner_hits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES requests(id),
    ts         INTEGER NOT NULL,
    severity   TEXT NOT NULL,   -- info | low | medium | high
    type       TEXT NOT NULL,
    detail     TEXT
  );

  CREATE TABLE IF NOT EXISTS saved_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    folder     TEXT    NOT NULL DEFAULT 'Default',
    request_id INTEGER REFERENCES requests(id),
    raw        TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS intercept_rules (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    enabled INTEGER NOT NULL DEFAULT 1,
    field   TEXT NOT NULL,   -- host | url | method | body
    op      TEXT NOT NULL,   -- contains | matches | equals | starts
    value   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS match_replace_rules (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    enabled INTEGER NOT NULL DEFAULT 1,
    scope   TEXT NOT NULL,   -- request | response | both
    field   TEXT NOT NULL,   -- header-name | header-value | body | url
    match   TEXT NOT NULL,   -- literal or regex
    replace TEXT NOT NULL,
    use_regex INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_req_ts   ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_req_host ON requests(host);
`);

/* ── Prepared statements ─────────────────────────────────── */
const stmts = {
  insertReq: db.prepare(`
    INSERT INTO requests (ts,method,scheme,host,port,path,url,req_headers,req_body)
    VALUES (@ts,@method,@scheme,@host,@port,@path,@url,@req_headers,@req_body)
  `),

  updateRes: db.prepare(`
    UPDATE requests
    SET res_status=@res_status, res_headers=@res_headers,
        res_body=@res_body, latency_ms=@latency_ms
    WHERE id=@id
  `),

  getById: db.prepare(`SELECT * FROM requests WHERE id=?`),

  list: db.prepare(`
    SELECT id,ts,method,scheme,host,port,path,url,
           res_status,latency_ms,flagged,tag
    FROM requests ORDER BY ts DESC LIMIT ?
  `),

  search: db.prepare(`
    SELECT id,ts,method,scheme,host,port,path,url,
           res_status,latency_ms,flagged,tag
    FROM requests
    WHERE (host LIKE ? OR url LIKE ? OR CAST(res_status AS TEXT) LIKE ?)
    ORDER BY ts DESC LIMIT 200
  `),

  flagReq: db.prepare(`UPDATE requests SET flagged=1 WHERE id=?`),

  deleteAll: db.prepare(`DELETE FROM requests`),

  insertHit: db.prepare(`
    INSERT INTO scanner_hits (request_id,ts,severity,type,detail)
    VALUES (@request_id,@ts,@severity,@type,@detail)
  `),

  hitsForReq: db.prepare(`SELECT * FROM scanner_hits WHERE request_id=?`),

  saveRequest: db.prepare(`
    INSERT INTO saved_requests (ts,name,folder,request_id,raw)
    VALUES (@ts,@name,@folder,@request_id,@raw)
  `),

  listSaved: db.prepare(`SELECT * FROM saved_requests ORDER BY folder,name`),

  deleteSaved: db.prepare(`DELETE FROM saved_requests WHERE id=?`),

  listRules: db.prepare(`SELECT * FROM intercept_rules`),
  addRule: db.prepare(`
    INSERT INTO intercept_rules (enabled,field,op,value)
    VALUES (@enabled,@field,@op,@value)
  `),
  toggleRule: db.prepare(`UPDATE intercept_rules SET enabled=? WHERE id=?`),
  deleteRule:  db.prepare(`DELETE FROM intercept_rules WHERE id=?`),

  listMRRules: db.prepare(`SELECT * FROM match_replace_rules`),
  addMRRule: db.prepare(`
    INSERT INTO match_replace_rules (enabled,scope,field,match,replace,use_regex)
    VALUES (@enabled,@scope,@field,@match,@replace,@use_regex)
  `),
  toggleMRRule: db.prepare(`UPDATE match_replace_rules SET enabled=? WHERE id=?`),
  deleteMRRule: db.prepare(`DELETE FROM match_replace_rules WHERE id=?`),
};

/* ── Public API ──────────────────────────────────────────── */
module.exports = {
  /** Insert a new request row; returns the assigned id */
  insertRequest(req) {
    const info = stmts.insertReq.run({
      ts:          Date.now(),
      method:      req.method || 'GET',
      scheme:      req.scheme || 'http',
      host:        req.host   || '',
      port:        req.port   || 80,
      path:        req.path   || '/',
      url:         req.url    || '',
      req_headers: JSON.stringify(req.headers || {}),
      req_body:    req.body   || null,
    });
    return info.lastInsertRowid;
  },

  /** Update the response columns on an existing row */
  updateResponse(id, res) {
    stmts.updateRes.run({
      id,
      res_status:  res.status     || null,
      res_headers: JSON.stringify(res.headers || {}),
      res_body:    res.body       || null,
      latency_ms:  res.latency_ms || null,
    });
  },

  getById(id)          { return stmts.getById.get(id); },
  list(limit = 200)    { return stmts.list.all(limit); },

  search(q) {
    const w = `%${q}%`;
    return stmts.search.all(w, w, w);
  },

  flagRequest(id)      { stmts.flagReq.run(id); },
  clearAll()           { stmts.deleteAll.run(); },

  addScannerHit(hit) {
    stmts.insertHit.run({
      request_id: hit.request_id,
      ts:         Date.now(),
      severity:   hit.severity,
      type:       hit.type,
      detail:     hit.detail || '',
    });
    this.flagRequest(hit.request_id);
  },

  getHitsForRequest(id) { return stmts.hitsForReq.all(id); },

  saveRequest(o)    { return stmts.saveRequest.run({ ts: Date.now(), ...o }); },
  listSaved()       { return stmts.listSaved.all(); },
  deleteSaved(id)   { stmts.deleteSaved.run(id); },

  listRules()           { return stmts.listRules.all(); },
  addRule(r)            { return stmts.addRule.run(r); },
  toggleRule(id, v)     { stmts.toggleRule.run(v, id); },
  deleteRule(id)        { stmts.deleteRule.run(id); },

  listMRRules()         { return stmts.listMRRules.all(); },
  addMRRule(r)          { return stmts.addMRRule.run(r); },
  toggleMRRule(id, v)   { stmts.toggleMRRule.run(v, id); },
  deleteMRRule(id)      { stmts.deleteMRRule.run(id); },

  close()               { db.close(); },
};
