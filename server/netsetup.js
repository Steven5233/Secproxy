/* ============================================================
   server/netsetup.js — Static virtual proxy interface
   Séç Proxy v2.0

   Creates a stable alias IP on the loopback interface so
   Drony can forward to a fixed address that is:
     - Different from 127.0.0.1  (no loop)
     - Different from cellular IP (no IP-change problem)
     - Always available          (no WiFi needed)

   Default alias: 127.100.100.1
   Override:      PROXY_ALIAS_IP=127.x.x.x node server/proxy.js

   ============================================================ */
'use strict';

const { execSync, execFileSync } = require('child_process');

const ALIAS_IP   = process.env.PROXY_ALIAS_IP || '127.100.100.1';
const ALIAS_CIDR = `${ALIAS_IP}/8`;
const IFACE      = 'lo';

/**
 * Check if the alias IP is already assigned to loopback.
 */
function isAliasActive() {
  try {
    const out = execSync(`ip addr show dev ${IFACE} 2>/dev/null`, { encoding: 'utf8' });
    return out.includes(ALIAS_IP);
  } catch (_) {
    return false;
  }
}

/**
 * Add the alias IP to loopback.
 * Returns true on success, false if it failed (e.g. no permission).
 */
function addAlias() {
  try {
    execFileSync('ip', ['addr', 'add', ALIAS_CIDR, 'dev', IFACE], {
      stdio: 'pipe',
    });
    return true;
  } catch (e) {
    // EEXIST means it's already there — treat as success
    if (e.stderr && e.stderr.toString().includes('RTNETLINK answers: File exists')) {
      return true;
    }
    return false;
  }
}

/**
 * Remove the alias IP from loopback (called on shutdown).
 */
function removeAlias() {
  try {
    execFileSync('ip', ['addr', 'del', ALIAS_CIDR, 'dev', IFACE], { stdio: 'pipe' });
  } catch (_) {
    // Ignore — it may already be gone
  }
}

/**
 * Setup the virtual proxy interface.
 * Call once at startup, before server.listen().
 *
 * Returns the alias IP string so proxy.js can bind to it.
 */
function setup() {
  if (isAliasActive()) {
    console.log(`[NET] Alias ${ALIAS_IP} already active on ${IFACE}`);
    return ALIAS_IP;
  }

  const ok = addAlias();
  if (ok && isAliasActive()) {
    console.log(`[NET] ✓ Alias ${ALIAS_IP}/8 added to ${IFACE}`);
    console.log(`[NET]   Drony → Proxy host: ${ALIAS_IP}  Port: 8080`);
    return ALIAS_IP;
  }

  // Fallback: couldn't add alias (no permission on some devices)
  console.warn(`[NET] ⚠ Could not add alias ${ALIAS_IP} — falling back to 0.0.0.0`);
  console.warn(`[NET]   If Drony loops, try: PROXY_ALIAS_IP=10.0.0.1 bash start.sh`);
  return '0.0.0.0';
}

/**
 * Teardown — call on SIGINT/SIGTERM.
 */
function teardown() {
  if (isAliasActive()) {
    removeAlias();
    console.log(`[NET] Alias ${ALIAS_IP} removed from ${IFACE}`);
  }
}

module.exports = { setup, teardown, aliasIP: ALIAS_IP };
