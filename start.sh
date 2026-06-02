#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
#  Séç Proxy v2.0 — Termux launcher
#  Run:  bash start.sh
# ============================================================

PROXY_PORT=${PROXY_PORT:-8080}
WS_PORT=${WS_PORT:-8081}
UI_PORT=${UI_PORT:-3000}
ROOT="$(cd "$(dirname "$0")" && pwd)"

# Use project-local log dir instead of /tmp (Termux-safe)
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
PROXY_LOG="$LOG_DIR/proxy.log"
UI_LOG="$LOG_DIR/ui.log"

# Truncate old logs
> "$PROXY_LOG"
> "$UI_LOG"

# Keep screen alive
termux-wake-lock 2>/dev/null

# Get LAN IP
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
echo "║  Download CA cert → Settings tab in UI          ║"
echo "║  Or: http://127.0.0.1:$UI_PORT/api/ca.crt"
echo "╚══════════════════════════════════════════════════╝"
echo ""

cd "$ROOT"

# ── Check Node.js ─────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[!] Node.js not found."
  echo "    Fix: pkg install nodejs"
  exit 1
fi

NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null)
echo "[*] Node.js v$(node --version | tr -d v) detected"

# ── Install / fix dependencies ────────────────────────────────
if [ ! -d node_modules ] || [ ! -d node_modules/sql.js ] || [ ! -d node_modules/ws ] || [ ! -d node_modules/node-forge ]; then
  echo ""
  echo "[*] Installing dependencies..."
  echo "    (sql.js is pure JS — no compilation needed)"
  echo ""

  # Remove any broken better-sqlite3 if it exists
  rm -rf node_modules/better-sqlite3 2>/dev/null

  npm install --omit=dev 2>&1 | tail -5

  if [ $? -ne 0 ]; then
    echo "[!] npm install failed. Trying with --legacy-peer-deps..."
    npm install --omit=dev --legacy-peer-deps 2>&1 | tail -5
  fi
  echo ""
fi

# Verify sql.js installed
if [ ! -d node_modules/sql.js ]; then
  echo "[!] sql.js not found. Running targeted install..."
  npm install sql.js ws node-forge --omit=dev 2>&1 | tail -5
fi

echo "[*] Dependencies OK"
echo ""

# ── Start proxy server ────────────────────────────────────────
echo "[*] Starting proxy server on :$PROXY_PORT ..."
PROXY_PORT=$PROXY_PORT WS_PORT=$WS_PORT node server/proxy.js >> "$PROXY_LOG" 2>&1 &
PROXY_PID=$!

# Wait up to 10s for proxy to respond
READY=0
for i in $(seq 1 20); do
  sleep 0.5
  if node -e "
    const h=require('http');
    h.get('http://127.0.0.1:$PROXY_PORT/api/stats',r=>{process.exit(0)}).on('error',()=>process.exit(1));
  " 2>/dev/null; then
    READY=1
    echo "[+] Proxy server ready (PID $PROXY_PID)"
    break
  fi
done

if [ $READY -eq 0 ]; then
  echo "[!] Proxy server not responding. Last log:"
  tail -10 "$PROXY_LOG"
  echo ""
  echo "    Try manually: node server/proxy.js"
  echo "    Logs: $PROXY_LOG"
fi

# ── Start UI server ───────────────────────────────────────────
echo "[*] Starting UI server on :$UI_PORT ..."
PROXY_PORT=$PROXY_PORT UI_PORT=$UI_PORT node server/ui-server.js >> "$UI_LOG" 2>&1 &
UI_PID=$!

sleep 1

if kill -0 $UI_PID 2>/dev/null; then
  echo "[+] UI server ready    (PID $UI_PID)"
else
  echo "[!] UI server failed. Last log:"
  tail -5 "$UI_LOG"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "┌──────────────────────────────────────────────────┐"
echo "│  Séç Proxy running!                              │"
echo "│                                                  │"
echo "│  Open in browser:                                │"
echo "│  http://127.0.0.1:$UI_PORT                         │"
echo "│                                                  │"
echo "│  CA Cert download:                               │"
echo "│  http://127.0.0.1:$UI_PORT/api/ca.crt              │"
echo "│                                                  │"
echo "│  Logs: $ROOT/logs/                         │"
echo "└──────────────────────────────────────────────────┘"
echo ""

# Open browser
termux-open-url "http://127.0.0.1:$UI_PORT" 2>/dev/null \
  || xdg-open "http://127.0.0.1:$UI_PORT" 2>/dev/null \
  || echo "    Open http://127.0.0.1:$UI_PORT in your browser"

echo "[*] Press Ctrl+C to stop."
echo ""

# ── Cleanup ───────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "[*] Stopping Séç Proxy..."
  kill $PROXY_PID $UI_PID 2>/dev/null
  wait $PROXY_PID $UI_PID 2>/dev/null
  termux-wake-unlock 2>/dev/null
  echo "[+] Stopped."
  exit 0
}
trap cleanup INT TERM

# Stream logs to terminal
tail -f "$PROXY_LOG" "$UI_LOG" 2>/dev/null &
TAIL_PID=$!

wait $PROXY_PID
kill $TAIL_PID 2>/dev/null
