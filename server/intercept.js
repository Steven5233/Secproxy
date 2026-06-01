/* ============================================================
   server/intercept.js — Intercept engine (singleton)
   Séç Proxy v2.0
   ============================================================ */
'use strict';

const EventEmitter = require('events');
const db           = require('./db');

class InterceptEngine extends EventEmitter {
  constructor() {
    super();
    this.enabled = false;
    this.queue   = new Map();  // id → { request, resolve, reject, ts }
    this._seq    = 0;
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.emit('status', { enabled: this.enabled });
  }

  // ── Match rules against a request object ──────────────────
  _matches(req) {
    const rules = db.listRules().filter(r => r.enabled);
    if (!rules.length) return true;               // no rules = match all
    return rules.every(r => this._eval(r, req));
  }

  _fieldVal(field, req) {
    switch (field) {
      case 'host':   return req.host   || '';
      case 'url':    return req.url    || '';
      case 'method': return req.method || '';
      case 'body':   return req.body   || '';
      default:       return '';
    }
  }

  _eval(rule, req) {
    const hay = this._fieldVal(rule.field, req);
    switch (rule.op) {
      case 'contains': return hay.includes(rule.value);
      case 'equals':   return hay === rule.value;
      case 'starts':   return hay.startsWith(rule.value);
      case 'matches':  try { return new RegExp(rule.value).test(hay); } catch (_) { return false; }
      default:         return true;
    }
  }

  // ── Apply match-replace rules ─────────────────────────────
  applyMR(reqOrRes, scope) {
    const rules = db.listMR().filter(r => r.enabled && (r.scope === scope || r.scope === 'both'));
    let obj = { ...reqOrRes };
    for (const rule of rules) {
      try { obj = this._applyMR(obj, rule); } catch (_) {}
    }
    return obj;
  }

  _applyMR(obj, rule) {
    const rep = (str) => {
      if (!str) return str;
      return rule.use_regex
        ? str.replace(new RegExp(rule.match_str, 'g'), rule.replace)
        : str.split(rule.match_str).join(rule.replace);
    };
    switch (rule.field) {
      case 'url':          return { ...obj, url: rep(obj.url), path: rep(obj.path) };
      case 'body':         return { ...obj, body: rep(obj.body) };
      case 'header-value': {
        const h = {};
        for (const [k,v] of Object.entries(obj.headers||{})) h[k] = rep(String(v));
        return { ...obj, headers: h };
      }
      case 'header-name': {
        const h = {};
        for (const [k,v] of Object.entries(obj.headers||{})) h[rep(k)] = v;
        return { ...obj, headers: h };
      }
      default: return obj;
    }
  }

  // ── Pause until forwarded/dropped ─────────────────────────
  pause(reqObj) {
    if (!this.enabled || !this._matches(reqObj)) {
      return Promise.resolve({ action:'forward', request:reqObj });
    }
    const id = ++this._seq;
    return new Promise((resolve) => {
      this.queue.set(id, { request:reqObj, resolve, ts:Date.now() });
      this.emit('paused', { id, request:reqObj });
    });
  }

  forward(id, modified) {
    const e = this.queue.get(id);
    if (!e) return false;
    this.queue.delete(id);
    e.resolve({ action:'forward', request: modified || e.request });
    this.emit('forwarded', { id });
    return true;
  }

  drop(id) {
    const e = this.queue.get(id);
    if (!e) return false;
    this.queue.delete(id);
    e.resolve({ action:'drop' });
    this.emit('dropped', { id });
    return true;
  }

  forwardAll() {
    for (const [id, e] of this.queue) {
      e.resolve({ action:'forward', request:e.request });
      this.emit('forwarded', { id });
    }
    this.queue.clear();
  }

  listPending() {
    return [...this.queue.entries()].map(([id, e]) => ({
      id, ts:e.ts, method:e.request.method,
      url:e.request.url, host:e.request.host,
    }));
  }
}

module.exports = new InterceptEngine();
