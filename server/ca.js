/* ============================================================
   ca.js — Root CA generator & per-host cert factory
   Séç Proxy v2.0
   Uses node-forge for all crypto operations.
   ============================================================ */

'use strict';

const forge  = require('node-forge');
const fs     = require('fs');
const path   = require('path');

const CA_DIR  = path.join(__dirname, 'ca');
const CA_KEY  = path.join(CA_DIR, 'ca.key.pem');
const CA_CERT = path.join(CA_DIR, 'ca.cert.pem');
const CA_DER  = path.join(CA_DIR, 'secproxy-ca.crt'); // install on Android

/* in-memory cache: hostname → { key, cert } forge objects */
const certCache = new Map();

/* ── Ensure CA dir exists ────────────────────────────────── */
if (!fs.existsSync(CA_DIR)) fs.mkdirSync(CA_DIR, { recursive: true });

/* ── Generate or load root CA ───────────────────────────── */
let caKey, caCert;

function generateCA() {
  console.log('[CA] Generating new root CA — this takes a few seconds...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert  = forge.pki.createCertificate();

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

  fs.writeFileSync(CA_KEY,  forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(CA_CERT, forge.pki.certificateToPem(cert));

  /* Write DER (.crt) for easy Android install */
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert));
  fs.writeFileSync(CA_DER, Buffer.from(der.getBytes(), 'binary'));

  console.log('[CA] Root CA written to server/ca/');
  console.log('[CA] Install server/ca/secproxy-ca.crt on Android to intercept HTTPS');
  return { privateKey: keys.privateKey, cert };
}

function loadCA() {
  const keyPem  = fs.readFileSync(CA_KEY,  'utf8');
  const certPem = fs.readFileSync(CA_CERT, 'utf8');
  return {
    privateKey: forge.pki.privateKeyFromPem(keyPem),
    cert:       forge.pki.certificateFromPem(certPem),
  };
}

if (fs.existsSync(CA_KEY) && fs.existsSync(CA_CERT)) {
  try {
    ({ privateKey: caKey, cert: caCert } = loadCA());
    console.log('[CA] Loaded existing root CA');
  } catch (e) {
    ({ privateKey: caKey, cert: caCert } = generateCA());
  }
} else {
  ({ privateKey: caKey, cert: caCert } = generateCA());
}

/* ── Generate a spoofed cert for a hostname ─────────────── */
function getCertForHost(hostname) {
  if (certCache.has(hostname)) return certCache.get(hostname);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert  = forge.pki.createCertificate();

  cert.publicKey    = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  const isIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

  const attrs = [
    { name: 'commonName',       value: hostname     },
    { name: 'organizationName', value: 'SecProxy'   },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes);

  const altNames = isIP
    ? [{ type: 7, ip: hostname }]
    : [
        { type: 2, value: hostname },
        { type: 2, value: `*.${hostname}` },
      ];

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  const entry = {
    key:  forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
  certCache.set(hostname, entry);
  return entry;
}

module.exports = {
  caKeyPem:  forge.pki.privateKeyToPem(caKey),
  caCertPem: forge.pki.certificateToPem(caCert),
  caCertDerPath: CA_DER,
  getCertForHost,
};
