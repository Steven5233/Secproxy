/* ============================================================
   server/ca.js — Root CA generator & per-host cert factory
   Séç Proxy v2.0

   FIX Bug 18: Per-host cert cache is now bounded with an LRU
   eviction policy (max CERT_CACHE_SIZE entries, default 500).
   Oldest entries are evicted when the limit is reached.

   FIX Bug 19: getCertForHost() now generates the RSA key pair
   asynchronously (forge's async API with workers) so the
   Node.js event loop is not blocked during key generation.
   The function returns a Promise; callers in mitm.js await it.

   FIX Bug 5 (Android): Root CA generation is now fully async —
   generateCA() was synchronous and blocked the Node.js event
   loop for 20-40s on phone CPUs, causing Android to kill the
   process before module.exports was reached. module.exports
   now contains a stable caInitPromise so callers can await
   readiness before the first CONNECT is handled.
   ============================================================ */
'use strict';

const forge = require('node-forge');
const fs    = require('fs');
const path  = require('path');

const CA_DIR  = path.join(__dirname, 'ca');
const CA_KEY  = path.join(CA_DIR, 'ca.key.pem');
const CA_CERT = path.join(CA_DIR, 'ca.cert.pem');
const CA_DER  = path.join(CA_DIR, 'secproxy-ca.crt');   // install on Android

if (!fs.existsSync(CA_DIR)) fs.mkdirSync(CA_DIR, { recursive: true });

// ── FIX Bug 18: Bounded LRU cache ────────────────────────────
const CERT_CACHE_SIZE = parseInt(process.env.CERT_CACHE_SIZE || '500', 10);

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  has(key) { return this.map.has(key); }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, val);
  }
}

const cache    = new LRUCache(CERT_CACHE_SIZE);
const inflight = new Map();

let caKey, caCert;

// ── Async key generation — never blocks the event loop ───────
function generateKeyPairAsync(bits) {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits, workers: -1 }, (err, keypair) => {
      if (err) reject(err);
      else resolve(keypair);
    });
  });
}

// ── FIX Bug 5: Async root CA init ────────────────────────────
// Replaces the old synchronous generateCA() + top-level try/catch
// that froze Node.js for 20-40s on phone CPUs. The proxy now waits
// for caInitPromise before listening, so nothing crashes.
async function initCA() {
  if (fs.existsSync(CA_KEY) && fs.existsSync(CA_CERT)) {
    // Fast path: load from disk (microseconds)
    caKey  = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY,  'utf8'));
    caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT, 'utf8'));
    console.log('[CA] Loaded existing root CA');
    return;
  }

  // Slow path: first run — generate async so event loop stays alive
  console.log('[CA] Generating root CA (async) — first run, may take ~30s on phone...');
  const keys = await generateKeyPairAsync(2048);

  const cert = forge.pki.createCertificate();
  cert.publicKey    = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName',       value: 'Sec Proxy CA' },
    { name: 'organizationName', value: 'SecProxy'     },
    { name: 'countryName',      value: 'NG'           },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  caKey  = keys.privateKey;
  caCert = cert;

  fs.writeFileSync(CA_KEY,  forge.pki.privateKeyToPem(caKey));
  fs.writeFileSync(CA_CERT, forge.pki.certificateToPem(caCert));

  // Write DER for Android install
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(caCert));
  fs.writeFileSync(CA_DER, Buffer.from(der.getBytes(), 'binary'));

  console.log('[CA] Root CA generated and saved to server/ca/');
  console.log('[CA] Install server/ca/secproxy-ca.crt on Android to decrypt HTTPS');
}

// Start init immediately — proxy.js awaits this before listening
const caInitPromise = initCA();

// ── Generate spoofed cert for a hostname (async) ─────────────
async function getCertForHost(hostname) {
  // Always wait for root CA to be ready first
  await caInitPromise;

  if (cache.has(hostname)) return cache.get(hostname);
  if (inflight.has(hostname)) return inflight.get(hostname);

  const promise = (async () => {
    const keys = await generateKeyPairAsync(2048);

    const cert  = forge.pki.createCertificate();
    cert.publicKey    = keys.publicKey;
    cert.serialNumber = String(Date.now());
    cert.validity.notBefore = new Date();
    cert.validity.notAfter  = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

    const isIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    cert.setSubject([{ name: 'commonName', value: hostname }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: isIP
          ? [{ type: 7, ip: hostname }]
          : [{ type: 2, value: hostname }, { type: 2, value: `*.${hostname}` }],
      },
    ]);
    cert.sign(caKey, forge.md.sha256.create());

    const entry = {
      key:  forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert),
    };
    cache.set(hostname, entry);
    inflight.delete(hostname);
    return entry;
  })();

  inflight.set(hostname, promise);
  return promise;
}

module.exports = {
  caCertDerPath: CA_DER,
  get caCertPem() {
    return caCert ? forge.pki.certificateToPem(caCert) : null;
  },
  caInitPromise,
  getCertForHost,
};
