#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
#  Séç Proxy v2.0 — Termux launcher
#  No configuration needed. Just run: bash start.sh
# ============================================================

PROXY_PORT=${PROXY_PORT:-8080}
WS_PORT=${WS_PORT:-8081}
UI_PORT=${UI_PORT:-3000}
ROOT="$(cd "$(dirname "$0")" && pwd)"

# Keep screen alive
termux-wake-lock 2>/dev/null

# Get LAN IP (so you can set Wi-Fi proxy from another device)
IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++){if($i=="src"){print $(i+1);exit}}}')
IP=${IP:-127.0.0.1}

clear
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║         Séç Proxy v2.0 — Termux Mode            ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  HTTP Proxy  →  $IP:$PROXY_PORT                    ║"
echo "║  Proxy UI    →  http://127.0.0.1:$UI_PORT          ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Browser proxy setup:                            ║"
echo "║  Firefox → Settings → Network → Manual Proxy    ║"
echo "║  HTTP: 127.0.0.1   Port: $PROXY_PORT               ║"
echo "║  Check: Also use for HTTPS                       ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  HTTPS (install CA cert):                        ║"
echo "║  Open http://127.0.0.1:$UI_PORT after start       ║"
echo "║  Go to Settings tab → Download CA Cert          ║"
echo "║  Install via Android Settings → Security         ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

cd "$ROOT"

# Install deps if needed
if [ ! -d node_modules ]; then
  echo "[*] Installing npm dependencies..."
  npm install --omit=dev
  echo ""
fi

# Start proxy server
PROXY_PORT=$PROXY_PORT WS_PORT=$WS_PORT node server/proxy.js &
PROXY_PID=$!
echo "[+] Proxy server started (PID $PROXY_PID)"

sleep 1

# Start UI server (serves ui/ folder)
python3 -m http.server $UI_PORT --directory ui --bind 127.0.0.1 &
UI_PID=$!
echo "[+] UI server started  (PID $UI_PID)"

sleep 0.5

echo ""
echo "[*] Opening http://127.0.0.1:$UI_PORT in browser..."
termux-open-url "http://127.0.0.1:$UI_PORT" 2>/dev/null || \
  xdg-open "http://127.0.0.1:$UI_PORT" 2>/dev/null || \
  echo "    Open http://127.0.0.1:$UI_PORT manually in your browser"

echo ""
echo "[*] Press Ctrl+C to stop."
trap "echo ''; echo 'Stopping...'; kill $PROXY_PID $UI_PID 2>/dev/null; termux-wake-unlock 2>/dev/null; exit 0" INT TERM
wait
