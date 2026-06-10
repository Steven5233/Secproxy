#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
#  Séç Proxy v2.0 — Termux launcher
#  Usage: bash start.sh
#
#  Ports:
#    8080 — HTTP proxy  (set this in Drony / Firefox)
#    8888 — REST API    (used internally by the UI)
#    8081 — WebSocket   (real-time push to UI)
#    3000 — Proxy UI    (open this in your browser)
# ============================================================

PROXY_PORT=${PROXY_PORT:-8080}
API_PORT=${API_PORT:-8888}
WS_PORT=${WS_PORT:-8081}
UI_PORT=${UI_PORT:-3000}
ALIAS_IP=${PROXY_ALIAS_IP:-127.100.100.1}

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
> "$LOG_DIR/proxy.log"
> "$LOG_DIR/ui.log"

# ── Keep screen alive ─────────────────────────────────────────
termux-wake-lock 2>/dev/null

# ── Get LAN IP ────────────────────────────────────────────────
IP=$(ip route get 1.1.1.1 2>/dev/null \
  | awk '{for(i=1;i<=NF;i++){if($i=="src"){print $(i+1);exit}}}')
IP=${IP:-127.0.0.1}

clear

echo ""
echo "  ███████╗███████╗ ██████╗    ██████╗ ██████╗  ██████╗ ██╗  ██╗██╗   ██╗"
echo "  ██╔════╝██╔════╝██╔════╝    ██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝╚██╗ ██╔╝"
echo "  ███████╗█████╗  ██║         ██████╔╝██████╔╝██║   ██║ ╚███╔╝  ╚████╔╝ "
echo "  ╚════██║██╔══╝  ██║         ██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗   ╚██╔╝  "
echo "  ███████║███████╗╚██████╗    ██║     ██║  ██║╚██████╔╝██╔╝ ██╗   ██║   "
echo "  ╚══════╝╚══════╝ ╚═════╝    ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝  "
echo ""
echo "  v2.0  ·  by Adoyi Steven (séç gúy)  ·  Termux Mode"
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                    SERVICE PORTS                        ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Proxy listener  →  $ALIAS_IP:$PROXY_PORT               ║"
echo "║  Proxy UI        →  http://127.0.0.1:$UI_PORT             ║"
echo "║  REST API        →  http://127.0.0.1:$API_PORT            ║"
echo "║  WebSocket       →  ws://127.0.0.1:$WS_PORT               ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                   DRONY SETUP                           ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Settings → Networks list → your mobile network         ║"
echo "║  Proxy type : HTTP                                       ║"
echo "║  Proxy host : $ALIAS_IP                                  ║"
echo "║  Proxy port : $PROXY_PORT                                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                 FIREFOX PROXY SETUP                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Settings → General → Network Settings                  ║"
echo "║  → Manual proxy configuration                           ║"
echo "║  HTTP Proxy : 127.0.0.1      Port : $PROXY_PORT               ║"
echo "║  ☑  Also use this proxy for HTTPS                       ║"
echo "║  No proxy for : (CLEAR THIS FIELD — leave it empty)     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                  CA CERT INSTALL                        ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Download : http://127.0.0.1:$UI_PORT/api/ca.crt          ║"
echo "║  Install  : Android Settings → Security                 ║"
echo "║             → Encryption & credentials                  ║"
echo "║             → Install a certificate → CA certificate    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

cd "$ROOT"

# ── Check Node.js ─────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "  [!] Node.js not found."
  echo "      Fix: pkg install nodejs"
  exit 1
fi

echo "  [*] Node.js $(node --version) detected"
echo ""

# ── Install dependencies (first run or missing) ───────────────
if [ ! -d node_modules/sql.js ]     || \
   [ ! -d node_modules/ws ]         || \
   [ ! -d node_modules/node-forge ]; then

  echo "  [*] Installing npm dependencies..."
  echo "      (sql.js is pure JavaScript — no compilation needed)"
  echo ""

  # Remove broken native module from any previous attempt
  rm -rf node_modules/better-sqlite3 2>/dev/null

  npm install --omit=dev 2>&1 | tail -6

  if [ $? -ne 0 ]; then
    echo "  [!] npm install failed. Retrying with --legacy-peer-deps..."
    npm install --omit=dev --legacy-peer-deps 2>&1 | tail -6
  fi

  echo ""
fi

echo "  [*] Dependencies OK"
echo ""

# ── Add virtual alias IP (no root needed) ─────────────────────
echo "  [*] Setting up proxy alias IP: $ALIAS_IP ..."
ip addr add "${ALIAS_IP}/8" dev lo 2>/dev/null
if ip addr show dev lo 2>/dev/null | grep -q "$ALIAS_IP"; then
  echo "  [+] Alias $ALIAS_IP active on loopback"
  echo "      → Set Drony proxy host to: $ALIAS_IP"
else
  echo "  [!] Could not add alias — proxy will bind to 0.0.0.0"
  echo "      → Set Drony proxy host to your cellular IP: $IP"
  ALIAS_IP="0.0.0.0"
fi
echo ""

# ── Start proxy server ────────────────────────────────────────
echo "  [*] Starting proxy server  (port $PROXY_PORT) ..."

PROXY_PORT=$PROXY_PORT \
API_PORT=$API_PORT \
WS_PORT=$WS_PORT \
PROXY_ALIAS_IP=$ALIAS_IP \
  node server/proxy.js >> "$LOG_DIR/proxy.log" 2>&1 &

PROXY_PID=$!

# Poll until API responds — up to 15s (first run CA generation takes time)
READY=0
echo -n "  [*] Waiting for proxy"
for i in $(seq 1 30); do
  sleep 0.5
  printf "."
  if node -e "
    const h = require('http');
    h.get('http://127.0.0.1:$API_PORT/api/stats', () => process.exit(0))
     .on('error', () => process.exit(1));
  " 2>/dev/null; then
    READY=1
    break
  fi
done
echo ""

if [ $READY -eq 1 ]; then
  echo "  [+] Proxy server ready   (PID $PROXY_PID)"
else
  echo "  [!] Proxy server not responding after 15s"
  echo "      Last log lines:"
  tail -8 "$LOG_DIR/proxy.log"
  echo ""
  echo "      Try manually: node server/proxy.js"
fi

echo ""

# ── Start UI server ───────────────────────────────────────────
echo "  [*] Starting UI server     (port $UI_PORT) ..."

PROXY_PORT=$PROXY_PORT \
API_PORT=$API_PORT \
UI_PORT=$UI_PORT \
  node server/ui-server.js >> "$LOG_DIR/ui.log" 2>&1 &

UI_PID=$!
sleep 1

if kill -0 $UI_PID 2>/dev/null; then
  echo "  [+] UI server ready      (PID $UI_PID)"
else
  echo "  [!] UI server failed to start"
  echo "      Last log lines:"
  tail -5 "$LOG_DIR/ui.log"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║               ALL SERVICES RUNNING                      ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║   Open this in your browser:                             ║"
echo "║   http://127.0.0.1:$UI_PORT                               ║"
echo "║                                                          ║"
echo "║   Drony proxy host : $ALIAS_IP                           ║"
echo "║   Drony proxy port : $PROXY_PORT                              ║"
echo "║                                                          ║"
echo "║   Logs: $ROOT/logs/               ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Open browser ──────────────────────────────────────────────
termux-open-url "http://127.0.0.1:$UI_PORT" 2>/dev/null \
  || xdg-open    "http://127.0.0.1:$UI_PORT" 2>/dev/null \
  || echo "  Open http://127.0.0.1:$UI_PORT in your browser"

echo ""
echo "  Press Ctrl+C to stop all services."
echo ""

# ── Cleanup on exit ───────────────────────────────────────────
cleanup() {
  echo ""
  echo "  [*] Stopping Séç Proxy..."
  kill $PROXY_PID $UI_PID 2>/dev/null
  wait $PROXY_PID $UI_PID 2>/dev/null
  # Remove alias IP cleanly
  ip addr del "${ALIAS_IP}/8" dev lo 2>/dev/null
  echo "  [+] Alias $ALIAS_IP removed"
  termux-wake-unlock 2>/dev/null
  echo "  [+] All services stopped. Goodbye."
  exit 0
}
trap cleanup INT TERM

# Stream logs to terminal so you can watch live traffic
tail -f "$LOG_DIR/proxy.log" "$LOG_DIR/ui.log" 2>/dev/null &
TAIL_PID=$!
trap "cleanup; kill $TAIL_PID 2>/dev/null" INT TERM

wait $PROXY_PID
kill $TAIL_PID 2>/dev/null
