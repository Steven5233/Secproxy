#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
#  Séç Proxy v2.0 — Termux launcher
#  No configuration needed. Just run: bash start.sh
# ============================================================

PROXY_PORT=${PROXY_PORT:-8080}
WS_PORT=${WS_PORT:-8081}
UI_PORT=${UI_PORT:-3000}
ROOT="$(cd "$(dirname "$0")" && pwd)"

# Keep screen alive while proxy runs
termux-wake-lock 2>/dev/null

# Get LAN IP for Wi-Fi proxy setup on other devices
IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++){if($i=="src"){print $(i+1);exit}}}')
IP=${IP:-127.0.0.1}

clear
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║         Séç Proxy v2.0 — Termux Mode            ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  HTTP Proxy  →  $IP:$PROXY_PORT"
echo "║  Proxy UI    →  http://127.0.0.1:$UI_PORT"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Firefox proxy setup:                            ║"
echo "║  Settings → Network → Manual Proxy              ║"
echo "║  HTTP: 127.0.0.1   Port: $PROXY_PORT"
echo "║  ☑ Also use for HTTPS                            ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Download CA cert (fixes HTTPS):                 ║"
echo "║  http://127.0.0.1:$UI_PORT/api/ca.crt"
echo "╚══════════════════════════════════════════════════╝"
echo ""

cd "$ROOT"

# ── Install npm deps on first run ────────────────────────────
if [ ! -d node_modules ]; then
  echo "[*] Installing npm dependencies (first run — takes ~2 min)..."
  npm install --omit=dev 2>&1
  if [ $? -ne 0 ]; then
    echo "[!] npm install failed. Trying with legacy peer deps..."
    npm install --omit=dev --legacy-peer-deps 2>&1
  fi
  echo ""
fi

# ── Check Node is available ───────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[!] Node.js not found. Install it: pkg install nodejs"
  exit 1
fi

# ── Start proxy server ────────────────────────────────────────
echo "[*] Starting proxy server on port $PROXY_PORT..."
PROXY_PORT=$PROXY_PORT WS_PORT=$WS_PORT node server/proxy.js > /tmp/secproxy.log 2>&1 &
PROXY_PID=$!
echo "[+] Proxy server started (PID $PROXY_PID)"

# Wait for proxy to be ready (up to 8 seconds)
echo "[*] Waiting for proxy server to be ready..."
for i in $(seq 1 16); do
  sleep 0.5
  if node -e "
    const http = require('http');
    http.get('http://127.0.0.1:$PROXY_PORT/api/stats', r => {
      process.exit(0);
    }).on('error', () => process.exit(1));
  " 2>/dev/null; then
    echo "[+] Proxy server is ready."
    break
  fi
  if [ $i -eq 16 ]; then
    echo "[!] Proxy server took too long. Check /tmp/secproxy.log"
    echo "    Last log lines:"
    tail -5 /tmp/secproxy.log 2>/dev/null
  fi
done

# ── Start UI server (Node — proxies /api/* correctly) ─────────
echo "[*] Starting UI server on port $UI_PORT..."
PROXY_PORT=$PROXY_PORT UI_PORT=$UI_PORT node server/ui-server.js > /tmp/secproxy-ui.log 2>&1 &
UI_PID=$!

sleep 0.8

# Confirm UI server is up
if kill -0 $UI_PID 2>/dev/null; then
  echo "[+] UI server started (PID $UI_PID)"
else
  echo "[!] UI server failed to start. Check /tmp/secproxy-ui.log"
  cat /tmp/secproxy-ui.log 2>/dev/null
fi

echo ""
echo "┌─────────────────────────────────────────────────┐"
echo "│  All services running. Opening UI...            │"
echo "│                                                 │"
echo "│  Proxy UI   → http://127.0.0.1:$UI_PORT          │"
echo "│  CA Cert    → http://127.0.0.1:$UI_PORT/api/ca.crt│"
echo "│  Proxy      → 127.0.0.1:$PROXY_PORT               │"
echo "└─────────────────────────────────────────────────┘"
echo ""

# ── Open browser ──────────────────────────────────────────────
termux-open-url "http://127.0.0.1:$UI_PORT" 2>/dev/null \
  || xdg-open   "http://127.0.0.1:$UI_PORT" 2>/dev/null \
  || echo "    Open http://127.0.0.1:$UI_PORT in your browser"

echo "[*] Press Ctrl+C to stop all services."
echo ""

# ── Cleanup on exit ───────────────────────────────────────────
cleanup() {
  echo ""
  echo "[*] Shutting down Séç Proxy..."
  kill $PROXY_PID $UI_PID 2>/dev/null
  wait $PROXY_PID $UI_PID 2>/dev/null
  termux-wake-unlock 2>/dev/null
  echo "[+] Stopped. Goodbye."
  exit 0
}
trap cleanup INT TERM

# Keep script alive; tail logs to terminal
tail -f /tmp/secproxy.log /tmp/secproxy-ui.log 2>/dev/null &
TAIL_PID=$!
trap "cleanup; kill $TAIL_PID 2>/dev/null" INT TERM

wait $PROXY_PID
