/* ============================================================
   server/db.js — SQLite persistence layer
   Séç Proxy v2.0
   ============================================================ */
'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'secproxy.db');
const db      = new Database(DB_PATH);

// ── Schema ──────────────────────────────────────────────────
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous  = NORMAL;

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
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
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
    request_id INTEGER REFERENCES requests(id),
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

  CREATE INDEX IF NOT EXISTS idx_req_ts   ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_req_host ON requests(host);
  CREATE INDEX IF NOT EXISTS idx_req_flag ON requests(flagged);
`);

// ── Prepared statements ──────────────────────────────────────
const S = {
  insertReq: db.prepare(`
    INSERT INTO requests (ts,method,scheme,host,port,path,url,req_headers,req_body)
    VALUES (@ts,@method,@scheme,@host,@port,@path,@url,@req_headers,@req_body)
  `),
  updateRes: db.prepare(`
    UPDATE requests SET res_status=@res_status,res_headers=@res_headers,
    res_body=@res_body,latency_ms=@latency_ms WHERE id=@id
  `),
  getById:    db.prepare(`SELECT * FROM requests WHERE id=?`),
  list:       db.prepare(`SELECT id,ts,method,scheme,host,port,path,url,req_headers,req_body,res_status,res_headers,res_body,latency_ms,flagged,tag FROM requests ORDER BY ts DESC LIMIT ?`),
  search:     db.prepare(`SELECT id,ts,method,scheme,host,port,path,url,res_status,latency_ms,flagged,tag FROM requests WHERE host LIKE ? OR url LIKE ? OR CAST(res_status AS TEXT) LIKE ? ORDER BY ts DESC LIMIT 500`),
  clearAll:   db.prepare(`DELETE FROM requests`),
  flagReq:    db.prepare(`UPDATE requests SET flagged=1 WHERE id=?`),
  insertHit:  db.prepare(`INSERT INTO scanner_hits(request_id,ts,severity,type,detail) VALUES(@request_id,@ts,@severity,@type,@detail)`),
  hitsForReq: db.prepare(`SELECT * FROM scanner_hits WHERE request_id=?`),
  saveReq:    db.prepare(`INSERT INTO saved_requests(ts,name,folder,request_id,raw) VALUES(@ts,@name,@folder,@request_id,@raw)`),
  listSaved:  db.prepare(`SELECT * FROM saved_requests ORDER BY folder,name`),
  delSaved:   db.prepare(`DELETE FROM saved_requests WHERE id=?`),
  listRules:  db.prepare(`SELECT * FROM intercept_rules ORDER BY id`),
  addRule:    db.prepare(`INSERT INTO intercept_rules(enabled,field,op,value) VALUES(@enabled,@field,@op,@value)`),
  delRule:    db.prepare(`DELETE FROM intercept_rules WHERE id=?`),
  listMR:     db.prepare(`SELECT * FROM match_replace_rules ORDER BY id`),
  addMR:      db.prepare(`INSERT INTO match_replace_rules(enabled,scope,field,match_str,replace,use_regex) VALUES(@enabled,@scope,@field,@match_str,@replace,@use_regex)`),
  delMR:      db.prepare(`DELETE FROM match_replace_rules WHERE id=?`),
};

// ── API ──────────────────────────────────────────────────────
module.exports = {
  insertRequest(r) {
    return S.insertReq.run({
      ts: Date.now(), method: r.method||'GET', scheme: r.scheme||'http',
      host: r.host||'', port: r.port||80, path: r.path||'/',
      url: r.url||'', req_headers: JSON.stringify(r.headers||{}), req_body: r.body||null,
    }).lastInsertRowid;
  },
  updateResponse(id, r) {
    S.updateRes.run({ id, res_status: r.status||null, res_headers: JSON.stringify(r.headers||{}), res_body: r.body||null, latency_ms: r.latency_ms||null });
  },
  getById(id)       { return S.getById.get(id); },
  list(n=500)       { return S.list.all(n); },
  search(q)         { const w=`%${q}%`; return S.search.all(w,w,w); },
  clearAll()        { S.clearAll.run(); },
  flagRequest(id)   { S.flagReq.run(id); },
  addHit(h)         { S.insertHit.run({ request_id:h.request_id, ts:Date.now(), severity:h.severity, type:h.type, detail:h.detail||'' }); this.flagRequest(h.request_id); },
  hitsFor(id)       { return S.hitsForReq.all(id); },
  saveRequest(o)    { return S.saveReq.run({ ts:Date.now(), ...o }); },
  listSaved()       { return S.listSaved.all(); },
  deleteSaved(id)   { S.delSaved.run(id); },
  listRules()       { return S.listRules.all(); },
  addRule(r)        { return S.addRule.run(r); },
  deleteRule(id)    { S.delRule.run(id); },
  listMR()          { return S.listMR.all(); },
  addMR(r)          { return S.addMR.run(r); },
  deleteMR(id)      { S.delMR.run(id); },
  close()           { db.close(); },
};
