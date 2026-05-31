/* ============================================================
   intercept.js — Intercept engine
   Séç Proxy v2.0

   Manages the paused-request queue. When intercept mode is ON
   every matching request is held here until the UI calls
   forward() or drop().
   ============================================================ */

'use strict';

const EventEmitter = require('events');
const db           = require('./db');

class InterceptEngine extends EventEmitter {
  constructor() {
    super();
    this.enabled  = false;   // global intercept on/off
    this.queue    = new Map(); // id → { req, resolve, reject, ts }
    this._counter = 0;
  }

  /* ── Toggle intercept on/off ─────────────────────────── */
  setEnabled(v) {
    this.enabled = !!v;
    this.emit('status', { enabled: this.enabled });
  }

  /* ── Match-rule evaluation ───────────────────────────── */
  _matchesRules(requestObj) {
    const rules = db.listRules().filter(r => r.enabled);
    if (!rules.length) return true; // no rules = intercept everything

    return rules.every(rule => {
      const haystack = this._fieldValue(rule.field, requestObj);
      return this._evaluate(rule.op, haystack, rule.value);
    });
  }

  _fieldValue(field, req) {
    switch (field) {
      case 'host':   return req.host   || '';
      case 'url':    return req.url    || '';
      case 'method': return req.method || '';
      case 'body':   return req.body   || '';
      default:       return '';
    }
  }

  _evaluate(op, haystack, needle) {
    switch (op) {
      case 'contains': return haystack.includes(needle);
      case 'equals':   return haystack === needle;
      case 'starts':   return haystack.startsWith(needle);
      case 'matches': {
        try { return new RegExp(needle).test(haystack); } catch (_) { return false; }
      }
      default: return true;
    }
  }

  /* ── Apply match-and-replace rules ──────────────────── */
  applyMatchReplace(requestObj, scope) {
    const rules = db.listMRRules().filter(r => r.enabled &&
      (r.scope === scope || r.scope === 'both'));

    for (const rule of rules) {
      try {
        requestObj = this._applyRule(requestObj, rule);
      } catch (_) {}
    }
    return requestObj;
  }

  _applyRule(req, rule) {
    const replace = (str) => {
      if (!str) return str;
      if (rule.use_regex) {
        return str.replace(new RegExp(rule.match, 'g'), rule.replace);
      }
      return str.split(rule.match).join(rule.replace);
    };

    switch (rule.field) {
      case 'url':
        req = { ...req, url: replace(req.url), path: replace(req.path) };
        break;
      case 'body':
        req = { ...req, body: replace(req.body) };
        break;
      case 'header-value': {
        const headers = { ...req.headers };
        for (const k of Object.keys(headers)) {
          headers[k] = replace(String(headers[k]));
        }
        req = { ...req, headers };
        break;
      }
      case 'header-name': {
        const headers = {};
        for (const k of Object.keys(req.headers || {})) {
          const newKey = replace(k);
          headers[newKey] = req.headers[k];
        }
        req = { ...req, headers };
        break;
      }
    }
    return req;
  }

  /* ── Pause a request until forwarded/dropped ─────────── */
  pause(requestObj) {
    if (!this.enabled || !this._matchesRules(requestObj)) {
      return Promise.resolve({ action: 'forward', request: requestObj });
    }

    const id = ++this._counter;
    return new Promise((resolve, reject) => {
      this.queue.set(id, { request: requestObj, resolve, reject, ts: Date.now() });
      this.emit('paused', { id, request: requestObj });
    });
  }

  /* ── Forward (optionally with modifications) ─────────── */
  forward(id, modifiedRequest) {
    const entry = this.queue.get(id);
    if (!entry) return false;
    this.queue.delete(id);
    entry.resolve({ action: 'forward', request: modifiedRequest || entry.request });
    this.emit('forwarded', { id });
    return true;
  }

  /* ── Drop ────────────────────────────────────────────── */
  drop(id) {
    const entry = this.queue.get(id);
    if (!entry) return false;
    this.queue.delete(id);
    entry.resolve({ action: 'drop' });
    this.emit('dropped', { id });
    return true;
  }

  /* ── Forward all pending ─────────────────────────────── */
  forwardAll() {
    for (const [id, entry] of this.queue) {
      entry.resolve({ action: 'forward', request: entry.request });
      this.emit('forwarded', { id });
    }
    this.queue.clear();
  }

  /* ── List pending ────────────────────────────────────── */
  listPending() {
    return [...this.queue.entries()].map(([id, e]) => ({
      id,
      ts:      e.ts,
      method:  e.request.method,
      url:     e.request.url,
      host:    e.request.host,
    }));
  }
}

module.exports = new InterceptEngine(); // singleton
