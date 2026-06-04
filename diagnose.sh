#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
#  diagnose.sh — Séç Proxy network diagnostic
#  Run: bash diagnose.sh
#  Tells you EXACTLY why the proxy isn't working
# ============================================================

PROXY_PORT=${PROXY_PORT:-8080}
API_PORT=${API_PORT:-8888}
PASS=0
FAIL=0

green() { echo "  ✓ $1"; PASS=$((PASS+1)); }
red()   { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
info()  { echo "  → $1"; }

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         Séç Proxy — Network Diagnostic              ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────
echo "[ 1 ] Node.js"
if command -v node &>/dev/null; then
  VER=$(node --version)
  green "Node.js $VER found"
else
  red "Node.js NOT found — run: pkg install nodejs"
fi

# ── 2. Check processes ────────────────────────────────────────
echo ""
echo "[ 2 ] Running processes"
PROXY_RUNNING=$(pgrep -f "node server/proxy.js" | head -1)
UI_RUNNING=$(pgrep -f "node server/ui-server.js" | head -1)

if [ -n "$PROXY_RUNNING" ]; then
  green "proxy.js is running (PID $PROXY_RUNNING)"
else
  red "proxy.js is NOT running — run: bash start.sh"
fi

if [ -n "$UI_RUNNING" ]; then
  green "ui-server.js is running (PID $UI_RUNNING)"
else
  red "ui-server.js is NOT running"
fi

# ── 3. Check ports ────────────────────────────────────────────
echo ""
echo "[ 3 ] Port bindings"

check_port() {
  local PORT=$1
  local NAME=$2
  if ss -tlnp 2>/dev/null | grep -q ":$PORT " || \
     netstat -tlnp 2>/dev/null | grep -q ":$PORT "; then
    green "Port $PORT ($NAME) is LISTENING"
    return 0
  else
    red "Port $PORT ($NAME) is NOT listening"
    return 1
  fi
}

check_port $PROXY_PORT "proxy"
check_port $API_PORT   "API"
check_port 8081        "WebSocket"
check_port 3000        "UI"

# ── 4. Raw TCP connect test ───────────────────────────────────
echo ""
echo "[ 4 ] TCP connect test (port $PROXY_PORT)"

node -e "
const net = require('net');
const s = net.connect($PROXY_PORT, '127.0.0.1', () => {
  process.stdout.write('CONNECTED\n');
  s.destroy();
  process.exit(0);
});
s.on('error', e => {
  process.stdout.write('ERROR: ' + e.message + '\n');
  process.exit(1);
});
s.setTimeout(3000);
s.on('timeout', () => {
  process.stdout.write('TIMEOUT\n');
  s.destroy();
  process.exit(2);
});
" 2>/dev/null
TCP_RESULT=$?

if [ $TCP_RESULT -eq 0 ]; then
  green "TCP connect to 127.0.0.1:$PROXY_PORT successful"
else
  red "TCP connect to 127.0.0.1:$PROXY_PORT FAILED"
  info "This is why the browser gets NetworkError"
fi

# ── 5. HTTP proxy request test ────────────────────────────────
echo ""
echo "[ 5 ] HTTP proxy request test"

HTTP_RESULT=$(node -e "
const net = require('net');
const s = net.connect($PROXY_PORT, '127.0.0.1', () => {
  s.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
});
let data = '';
s.on('data', d => { data += d.toString(); });
s.on('end', () => {
  if (data.startsWith('HTTP/')) {
    process.stdout.write('OK:' + data.split('\r\n')[0] + '\n');
  } else {
    process.stdout.write('BAD_RESPONSE:' + data.slice(0,50) + '\n');
  }
  process.exit(0);
});
s.on('error', e => { process.stdout.write('ERROR:' + e.message + '\n'); process.exit(1); });
s.setTimeout(5000);
s.on('timeout', () => { process.stdout.write('TIMEOUT\n'); s.destroy(); process.exit(2); });
" 2>/dev/null)

if echo "$HTTP_RESULT" | grep -q "^OK:"; then
  green "HTTP proxy request works: $(echo $HTTP_RESULT | cut -c4-60)"
elif echo "$HTTP_RESULT" | grep -q "^TIMEOUT"; then
  red "HTTP proxy request TIMED OUT"
  info "Proxy accepted connection but did not forward"
else
  red "HTTP proxy request FAILED: $HTTP_RESULT"
fi

# ── 6. API server test ────────────────────────────────────────
echo ""
echo "[ 6 ] API server test (port $API_PORT)"

API_RESULT=$(node -e "
const http = require('http');
http.get('http://127.0.0.1:$API_PORT/api/stats', res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const j = JSON.parse(d);
      process.stdout.write('OK:' + JSON.stringify(j).slice(0,80) + '\n');
    } catch(e) {
      process.stdout.write('BAD_JSON:' + d.slice(0,50) + '\n');
    }
    process.exit(0);
  });
}).on('error', e => {
  process.stdout.write('ERROR:' + e.message + '\n');
  process.exit(1);
});
setTimeout(() => { process.stdout.write('TIMEOUT\n'); process.exit(2); }, 3000);
" 2>/dev/null)

if echo "$API_RESULT" | grep -q "^OK:"; then
  green "API server responding: $(echo $API_RESULT | cut -c4-60)"
else
  red "API server FAILED: $API_RESULT"
fi

# ── 7. curl test ──────────────────────────────────────────────
echo ""
echo "[ 7 ] curl through proxy"

if command -v curl &>/dev/null; then
  CURL_RESULT=$(curl -s -x http://127.0.0.1:$PROXY_PORT http://example.com/ \
    --connect-timeout 5 --max-time 8 -o /dev/null -w "%{http_code}" 2>&1)
  if [ "$CURL_RESULT" = "200" ]; then
    green "curl through proxy returned HTTP 200"
  else
    red "curl through proxy failed: $CURL_RESULT"
    info "Try manually: curl -v -x http://127.0.0.1:$PROXY_PORT http://example.com/"
  fi
else
  info "curl not installed — skip: pkg install curl"
fi

# ── 8. Log check ──────────────────────────────────────────────
echo ""
echo "[ 8 ] Recent proxy log"
LOG="$HOME/Sec-proxy/logs/proxy.log"
if [ -f "$LOG" ]; then
  green "Log file found: $LOG"
  echo ""
  echo "  Last 15 lines:"
  tail -15 "$LOG" | sed 's/^/    /'
else
  red "No log file at $LOG"
  info "Run: bash start.sh"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
printf  "║  Results:  ✓ %d passed   ✗ %d failed" "$PASS" "$FAIL"
echo   "                      ║"
echo "╠══════════════════════════════════════════════════════╣"

if [ $FAIL -eq 0 ]; then
  echo "║  All checks passed. Proxy is working correctly.     ║"
  echo "║  If browser still fails:                            ║"
  echo "║  → Install the CA cert (Settings tab in UI)        ║"
  echo "║  → Test on http://neverssl.com first (no HTTPS)    ║"
elif ! pgrep -f "node server/proxy.js" > /dev/null; then
  echo "║  MAIN ISSUE: Proxy server is not running.           ║"
  echo "║  Fix: bash start.sh                                 ║"
elif [ $TCP_RESULT -ne 0 ]; then
  echo "║  MAIN ISSUE: Port 8080 is not reachable.            ║"
  echo "║  Fix: pkill -f proxy.js && bash start.sh            ║"
else
  echo "║  Some checks failed — see details above.            ║"
  echo "║  Share the output of this script for support.       ║"
fi
echo "╚══════════════════════════════════════════════════════╝"
echo ""
