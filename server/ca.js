/* ============================================================
   server/ca.js — Root CA generator & per-host cert factory
   Séç Proxy v2.0
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

// ── In-memory cert cache: hostname → { key, cert } strings ──
const cache = new Map();

// ── Generate or load root CA ─────────────────────────────────
let caKey, caCert;

function generateCA() {
  console.log('[CA] Generating root CA — please wait ~10s...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert  = forge.pki.createCertificate();
  cert.publicKey    = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const attrs = [
    { name:'commonName',       value:'Sec Proxy CA' },
    { name:'organizationName', value:'SecProxy'     },
    { name:'countryName',      value:'NG'           },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name:'basicConstraints', cA:true },
    { name:'keyUsage', keyCertSign:true, cRLSign:true },
    { name:'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(CA_KEY,  forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(CA_CERT, forge.pki.certificateToPem(cert));

  // Write DER for Android install
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert));
  fs.writeFileSync(CA_DER, Buffer.from(der.getBytes(), 'binary'));

  console.log('[CA] Root CA saved to server/ca/');
  console.log('[CA] Install server/ca/secproxy-ca.crt on Android to decrypt HTTPS');
  return { privateKey: keys.privateKey, cert };
}

try {
  if (fs.existsSync(CA_KEY) && fs.existsSync(CA_CERT)) {
    caKey  = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY,  'utf8'));
    caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT, 'utf8'));
    console.log('[CA] Loaded existing root CA');
  } else {
    ({ privateKey: caKey, cert: caCert } = generateCA());
  }
} catch (_) {
  ({ privateKey: caKey, cert: caCert } = generateCA());
}

// ── Generate spoofed cert for a hostname ─────────────────────
function getCertForHost(hostname) {
  if (cache.has(hostname)) return cache.get(hostname);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert  = forge.pki.createCertificate();
  cert.publicKey    = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  const isIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  cert.setSubject([{ name:'commonName', value:hostname }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name:'basicConstraints', cA:false },
    { name:'keyUsage', digitalSignature:true, keyEncipherment:true },
    { name:'extKeyUsage', serverAuth:true },
    {
      name:'subjectAltName',
      altNames: isIP
        ? [{ type:7, ip:hostname }]
        : [{ type:2, value:hostname }, { type:2, value:`*.${hostname}` }],
    },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const entry = {
    key:  forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
  cache.set(hostname, entry);
  return entry;
}

module.exports = {
  caCertDerPath: CA_DER,
  caCertPem: forge.pki.certificateToPem(caCert),
  getCertForHost,
};
