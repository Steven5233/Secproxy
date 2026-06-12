<div align="center">

<!-- BANNER -->
<img src="https://img.shields.io/badge/Séç_Proxy-v2.0-00ff9d?style=for-the-badge&labelColor=0a0c0f&color=00ff9d" alt="version">
<img src="https://img.shields.io/badge/Platform-Termux_%7C_Linux_%7C_macOS_%7C_Windows-00ff9d?style=for-the-badge&labelColor=0a0c0f&color=4fc3f7" alt="platform">
<img src="https://img.shields.io/badge/License-MIT-00ff9d?style=for-the-badge&labelColor=0a0c0f&color=a29bfe" alt="license">
<img src="https://img.shields.io/badge/Node.js-%3E%3D16-00ff9d?style=for-the-badge&labelColor=0a0c0f&color=ffa502" alt="node">

<br><br>

```
 ███████╗███████╗ ██████╗    ██████╗ ██████╗  ██████╗ ██╗  ██╗██╗   ██╗
 ██╔════╝██╔════╝██╔════╝    ██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝╚██╗ ██╔╝
 ███████╗█████╗  ██║         ██████╔╝██████╔╝██║   ██║ ╚███╔╝  ╚████╔╝ 
 ╚════██║██╔══╝  ██║         ██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗   ╚██╔╝  
 ███████║███████╗╚██████╗    ██║     ██║  ██║╚██████╔╝██╔╝ ██╗   ██║   
 ╚══════╝╚══════╝ ╚═════╝    ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝  
```

**Burp Suite-style intercepting HTTP/HTTPS proxy — built for Termux, desktop, and everywhere in between.**

[Features](#features) · [Installation](#installation) · [Android Setup](#android-setup-no-wifi) · [HTTPS Setup](#https-interception-setup) · [Drony Setup](#drony--cellular-interception) · [API Reference](#rest-api-reference) · [Changelog](#changelog) · [Author](#about-the-author)

<br>

</div>

---

## What is Séç Proxy?

Séç Proxy is a full-featured intercepting proxy tool inspired by Burp Suite Community Edition, written entirely in **Node.js** with a browser-based UI. It sits between your browser or app and the internet, giving you complete visibility and control over every HTTP and HTTPS request — intercept, inspect, edit, replay, and scan traffic in real time.

Built specifically to run on **Termux (Android)** with zero configuration, while also shipping with a full **Electron-based built-in browser** for desktop use that routes traffic through the proxy automatically — no manual proxy settings required.

Designed for ethical hacking, bug bounty hunting, CTF challenges, and security research.

---

## Features

### Core Proxy Engine
- **HTTP & HTTPS interception** — full MITM via dynamic CA certificate generation (node-forge)
- **Async CA generation** — root CA and per-host certs generated asynchronously; event loop never blocks even on low-end phone CPUs
- **HTTP/2 downgrade** — forces `http/1.1` ALPN negotiation so modern sites (Google, GitHub, Instagram) are intercepted correctly instead of returning empty responses
- **Deflate decompression fix** — handles both zlib-wrapped and raw deflate encoding; falls back automatically so no response body is ever garbled
- **WebSocket real-time push** — every captured request/response appears in the UI instantly
- **SQLite persistence** — complete request history survives restarts
- **Match & Replace rules** — auto-modify requests and responses in-flight using literal or regex patterns
- **Intercept rules** — filter exactly which requests to pause (by host, URL, method, body)
- **Virtual alias interface** — `netsetup.js` adds a static IP (`127.100.100.1`) to the loopback interface at startup so Drony and other tools always have a fixed, stable proxy address with no IP-change problem and no routing loop

### Built-in Browser (Desktop)
- **Electron window** pre-configured to route all traffic through the proxy — zero setup
- **Floating address bar** injected into every page (back, forward, reload, URL input, HTTPS indicator)
- **Certificate trust bypass** — the built-in browser automatically trusts the generated CA
- **Isolated session** — browser window uses a separate Electron partition so cookies and cache never bleed into the Proxy UI window

### Proxy UI — 6 Tabs
| Tab | Description |
|-----|-------------|
| **Proxy** | Live HTTP history table with search, method/status filters, request detail, HAR export |
| **Intercept** | Pause queue — view raw request, edit headers/body, forward or drop |
| **Repeater** | Resend any captured request with full header/param/cookie/body editor |
| **Decoder** | Base64, URL, HTML, Hex, JWT decode, JSON format, SHA-256 — chain operations |
| **Scanner** | Auto-flagged passive security findings with severity ratings |
| **Settings** | CA cert download, intercept rules, match-replace rules, live stats |

### Passive Security Scanner (16 checks)

| Severity | Finding |
|----------|---------|
| 🔴 High | CORS reflects arbitrary Origin with credentials |
| 🔴 High | HTTP Basic Authentication over plain HTTP |
| 🟠 Medium | Missing HSTS header |
| 🟠 Medium | CORS wildcard (`Access-Control-Allow-Origin: *`) |
| 🟠 Medium | Possible open redirect (cross-host Location header) |
| 🟠 Medium | Stack trace / debug info in response |
| 🟠 Medium | JWT token exposed in URL |
| 🟡 Low | Missing Content-Security-Policy |
| 🟡 Low | Missing X-Frame-Options |
| 🟡 Low | Cookie missing HttpOnly flag |
| 🟡 Low | Cookie missing Secure flag |
| 🔵 Info | Missing X-Content-Type-Options |
| 🔵 Info | Server version disclosed in header |
| 🔵 Info | Query parameter reflected unescaped in HTML |
| 🔵 Info | Private RFC1918 IP address in response body |
| 🔵 Info | Cookie missing SameSite attribute |

---

## Project Structure

```
sec-proxy/
│
├── browser/                     ← Built-in Electron browser (desktop)
│   ├── main.js                  ← Electron main: launches proxy, opens both windows
│   ├── preload.js               ← IPC bridge for Proxy UI window
│   └── browser-preload.js       ← Injects address bar into target browser
│
├── server/                      ← Node.js proxy engine
│   ├── proxy.js                 ← HTTP listener + REST API  (:8080)
│   ├── mitm.js                  ← HTTPS MITM via CONNECT hijack + TLS unwrap
│   ├── ca.js                    ← Async root CA generator + per-host cert factory
│   ├── netsetup.js              ← Virtual alias IP setup (127.100.100.1 on loopback)
│   ├── db.js                    ← SQLite schema + all prepared statements
│   ├── intercept.js             ← Pause / forward / drop engine (singleton)
│   ├── scanner.js               ← Passive security scanner (16 checks)
│   ├── ws-bridge.js             ← WebSocket real-time push to UI  (:8081)
│   └── ca/                      ← Auto-generated CA files (git-ignored)
│       ├── ca.key.pem
│       ├── ca.cert.pem
│       └── secproxy-ca.crt      ← Install this on Android / browser
│
├── ui/                          ← Browser-based frontend
│   ├── index.html               ← 6-tab UI layout
│   ├── style.css                ← Dark terminal theme
│   └── app.js                   ← All frontend logic + WebSocket client
│
├── package.json
├── start.sh                     ← Termux one-command launcher
├── secproxy.db                  ← Auto-created SQLite database
└── README.md
```

---

## Installation

### Requirements

| Runtime | Version | Notes |
|---------|---------|-------|
| Node.js | ≥ 16.0  | Required for proxy server |
| Electron | 29.x | Desktop built-in browser (optional) |

---

### Desktop (Windows / macOS / Linux)

```bash
# Clone the repository
git clone https://github.com/Steven5233/Sec-proxy.git
cd Sec-proxy

# Install all dependencies (including Electron)
npm install

# Launch — opens Proxy UI + Built-in Browser automatically
npm start
```

Two windows open with no further configuration:
- **Window 1** — Séç Proxy UI (history, intercept, repeater, decoder, scanner, settings)
- **Window 2** — Built-in browser, already proxied through port 8080

---

### Termux (Android) — Recommended

```bash
# Install system dependencies
pkg update && pkg upgrade -y
pkg install nodejs git -y

# Clone the repository
git clone https://github.com/Steven5233/Sec-proxy.git
cd Sec-proxy

# Launch — installs npm deps automatically on first run
bash start.sh
```

The launcher will:
1. Locate the `ip` binary in the Termux-specific path
2. Add a static virtual alias IP (`127.100.100.1`) to the loopback interface
3. Install npm dependencies if missing
4. Start the proxy server on `127.100.100.1:8080`
5. Start the UI static server on `:3000`
6. Open `http://127.0.0.1:3000` in your default browser automatically

---

### Headless / CI (no Electron)

```bash
# Proxy + static UI server
npm run start:nogui

# Proxy server only
npm run start:proxy
```

Then open `http://127.0.0.1:3000` in any browser.

---

## Android Setup (No WiFi)

Séç Proxy is designed to work fully on a phone using only the cellular data connection — no WiFi required. Two setups are supported depending on what you want to capture.

---

### Option A — Firefox (Easiest, Recommended)

Firefox for Android has built-in proxy settings that work over cellular with no extra apps:

```
Firefox → ⋮ Menu → Settings → General → Network Settings
→ Manual proxy configuration
  HTTP Proxy:  127.0.0.1    Port: 8080
  ☑ Also use this proxy for HTTPS
  No Proxy for: (leave this field completely empty)
→ OK
```

All Firefox traffic now flows through Séç Proxy. This is the zero-friction option.

---

### Option B — Drony + All Apps (Chrome, InDrive, any app)

Drony creates a local VPN that redirects all device traffic through the proxy. Séç Proxy uses a **virtual alias IP** (`127.100.100.1`) so Drony forwards to a different loopback address than the one it listens on — this prevents the routing loop that occurs when both addresses are `127.0.0.1`.

```
All apps
   ↓ (Drony VPN — listens on 127.0.0.1)
   ↓ (forwards to 127.100.100.1 — different address, no loop)
Séç Proxy :8080
   ↓
Internet (cellular)
```

#### Setup Steps

**1. Start Séç Proxy**
```bash
bash start.sh
```
The startup banner will confirm:
```
[+] Alias 127.100.100.1 active on loopback
```

**2. Configure Drony**

```
Drony → Settings → Networks list → (your mobile network / APN name)
  Proxy type:  HTTP
  Proxy host:  127.100.100.1
  Proxy port:  8080
→ Save
```

Go back to the **LOG** tab → toggle the switch **ON**.

The Drony log should show:
```
Proxy listening on 127.0.0.1:8019   ← Drony's own internal port (normal)
```
And connections will flow through to Séç Proxy at `127.100.100.1:8080`.

**3. Install the CA certificate** (required for HTTPS — see [HTTPS Interception Setup](#https-interception-setup))

**4. Open the Séç Proxy UI**
```
http://127.0.0.1:3000
```
Browse Chrome or open InDrive — all traffic appears in the Proxy tab in real time.

---

### Option C — ProxyDroid (Per-App, No Root)

ProxyDroid lets you capture specific apps only (e.g. Chrome + InDrive but not system apps), which avoids capturing Termux itself and eliminates any loop risk entirely.

```
ProxyDroid Settings:
  Host:         127.0.0.1
  Port:         8080
  Proxy type:   HTTP
  Global Proxy: OFF
  Per-App:      ON → select Chrome, InDrive, etc.
```

---

## HTTPS Interception Setup

Séç Proxy generates a local root CA on first launch and signs per-hostname certificates on the fly, exactly like Burp Suite. CA generation is **fully asynchronous** — even on low-end phone CPUs the proxy starts accepting connections immediately while the CA is generated in the background.

### Step 1 — Download the CA certificate

After starting the proxy, go to the **Settings** tab → click **Download CA Cert**.

Or fetch it directly from Termux:
```bash
curl http://127.0.0.1:8080/api/ca.crt -o /sdcard/secproxy-ca.crt
```

### Step 2 — Install on Android

```
Settings → Security → Encryption & credentials
→ Install a certificate → CA certificate
→ Select secproxy-ca.crt
→ Name it: SecProxy
```

On Tecno / HiOS devices:
```
Settings → Biometrics and Security → Install from storage
```

### Step 3 — Install on Desktop Browsers

**Firefox:**
```
Settings → Privacy & Security → Certificates → View Certificates
→ Authorities tab → Import → secproxy-ca.crt
→ ☑ Trust this CA to identify websites
```

**Chrome / Chromium:**
```
Settings → Privacy & Security → Security → Manage certificates
→ Authorities → Import → secproxy-ca.crt
→ Trust for identifying websites
```

**macOS system-wide:**
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain secproxy-ca.crt
```

> **Certificate pinning note:** Apps that implement SSL/TLS certificate pinning (most banking, payment, and government apps) will reject the MITM cert. Bypassing certificate pinning requires additional tooling (Frida, Magisk + TrustMeAlready) and is outside the scope of this tool.

---

## REST API Reference

The proxy exposes a REST API on the same port as the proxy listener (`8080`). All endpoints return JSON with `Access-Control-Allow-Origin: *`.

### Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/requests` | List all captured requests (last 1000) |
| `GET` | `/api/requests/:id` | Get full request + response + scanner hits |
| `POST` | `/api/requests/clear` | Delete all captured requests |
| `POST` | `/api/search` | `{ q: "keyword" }` — search host, URL, status |

### Repeater

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/repeat` | `{ method, url, headers, body }` — resend a request |

### Intercept

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/intercept/status` | `{ enabled, pending[] }` |
| `POST` | `/api/intercept/toggle` | Toggle intercept on/off |
| `POST` | `/api/intercept/forward` | `{ id, request }` — forward (optionally modified) |
| `POST` | `/api/intercept/drop` | `{ id }` — drop a paused request |
| `POST` | `/api/intercept/forward-all` | Forward all pending requests |

### Rules

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/rules` | List intercept match rules |
| `POST` | `/api/rules` | `{ field, op, value }` — add rule |
| `DELETE` | `/api/rules/:id` | Delete a rule |
| `GET` | `/api/mr-rules` | List match-replace rules |
| `POST` | `/api/mr-rules` | `{ scope, field, match_str, replace }` — add rule |
| `DELETE` | `/api/mr-rules/:id` | Delete a rule |

### Utility

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/saved` | List saved requests |
| `POST` | `/api/saved` | Save a request by name |
| `DELETE` | `/api/saved/:id` | Delete a saved request |
| `GET` | `/api/stats` | `{ total, intercepted, errors, bytesIn, bytesOut, uptime }` |
| `GET` | `/api/ca.crt` | Download the CA certificate (DER format) |
| `GET` | `/api/info` | `{ proxyHost, proxyPort, wsPort }` |

---

## Ports Reference

| Port | Service | Configurable |
|------|---------|-------------|
| `8080` | HTTP proxy listener + REST API | `PROXY_PORT=xxxx` |
| `8081` | WebSocket bridge (UI real-time events) | `WS_PORT=xxxx` |
| `3000` | Static UI server (Termux / headless) | `UI_PORT=xxxx` |

Custom ports example:
```bash
PROXY_PORT=9090 WS_PORT=9091 UI_PORT=4000 bash start.sh
```

---

## Troubleshooting

**Proxy not responding at startup (Termux):**
The first-ever launch generates the root CA asynchronously — this can take 20–40 seconds on a phone CPU. The startup script waits up to 15 seconds then proceeds anyway. The proxy will be ready shortly after. Check `logs/proxy.log` for confirmation:
```bash
tail -f ~/Sec-proxy/logs/proxy.log
```

**`Could not add alias` warning at startup:**
The virtual alias IP setup requires the `ip` binary. If it isn't found, the proxy falls back to binding on `0.0.0.0` and the startup banner shows your cellular IP to use in Drony instead. Install `iproute2` to fix this permanently:
```bash
pkg install iproute2
```

**Port already in use:**
```bash
PROXY_PORT=8082 bash start.sh
```

**npm install fails on Termux:**
```bash
pkg install build-essential python -y
npm install
```

**HTTPS traffic not decrypted (shows as tunnel):**
- Install the CA certificate from Settings → Download CA Cert
- Restart your browser after installing the cert
- In Firefox, confirm "Also use this proxy for HTTPS" is checked and "No Proxy for" is empty

**Drony shows `ECONNREFUSED` errors:**
Séç Proxy is not running. Start it first:
```bash
bash ~/Sec-proxy/start.sh
```
Then toggle Drony off and on again.

**Drony forwards to wrong port / loops:**
Make sure Drony's proxy host is set to `127.100.100.1` (the alias IP), not `127.0.0.1`. Using `127.0.0.1` for both Drony's listener and the forwarding target creates an infinite routing loop.

**WebSocket not connecting (dot stays red in UI):**
- Confirm the proxy started successfully
- Verify port `8081` is not blocked
- Refresh the UI page

**App traffic not appearing (certificate pinning):**
Banking apps, payment apps, and some government apps implement certificate pinning and will reject the MITM certificate. This is by design in those apps and cannot be bypassed without root + Frida or Magisk modules.

---

## Changelog

### v2.0 (Current)

#### Bug Fixes
- **[Critical] Async CA generation** — root CA is now generated asynchronously using `node-forge`'s worker API. Previously the synchronous `generateKeyPair` call blocked the entire Node.js event loop for 20–40 seconds on phone CPUs, causing Android to kill the process before `module.exports` was set and producing a `TypeError: ca.getCertForHost is not a function` crash on every HTTPS CONNECT request
- **[Critical] HTTP/2 ALPN downgrade** — `tls.connect` in both `proxy.js` and `mitm.js` now passes `ALPNProtocols: ['http/1.1']`. Without this, servers that negotiate HTTP/2 respond with binary framing that the raw parser cannot understand, silently returning 502 for most modern HTTPS sites including Google, Instagram, and InDrive
- **[High] Deflate decompression** — `zlib.inflate` now falls back to `zlib.inflateRaw` when it fails. Many servers (nginx, older Apache, most Android app backends) send raw deflate without a zlib wrapper, causing the previous implementation to return garbled binary response bodies
- **[High] Array header serialization** — `forwardRaw` in both `proxy.js` and `mitm.js` now correctly handles array-valued headers (e.g. multiple `Cookie` lines) by emitting one header line per value instead of joining them with a comma
- **[Medium] CA cert download** — the Settings tab download button now uses `fetch()` + Blob URL instead of an `<a href>` tag. The old approach routed the download request through Drony, which forwarded it to the internet and returned a 404. The new approach hits `127.0.0.1:8080` directly as a loopback fetch, bypassing any VPN routing
- **[Medium] `decodeChunked` error handling** — malformed chunk size lines now return an empty buffer instead of the raw framed buffer, preventing downstream parsers from receiving chunked framing bytes as body content

#### New Features
- **`server/netsetup.js`** — new module that adds a static virtual alias IP (`127.100.100.1`) to the loopback interface at startup using `ip addr add`. This gives Drony and other proxy forwarders a fixed, stable address that is separate from `127.0.0.1`, eliminating the routing loop problem permanently. Falls back gracefully to `0.0.0.0` if the `ip` binary is unavailable
- **Termux `ip` binary path resolution** — `netsetup.js` and `start.sh` now search for the `ip` binary across all candidate paths including `/data/data/com.termux/files/usr/bin/ip` before falling back to a `which ip` shell lookup
- **`start.sh` health check fix** — the proxy readiness poll now correctly targets `127.0.0.1:$PROXY_PORT/api/stats` instead of the non-existent `API_PORT=8888`, so the "Proxy server ready" confirmation now appears correctly instead of always timing out

---

## Ethics & Legal

Séç Proxy is built for **ethical security research, penetration testing with authorization, bug bounty hunting, and education.**

- Only intercept traffic on systems and networks you own or have explicit written permission to test
- Do not use this tool to intercept third-party traffic without consent
- The author assumes no liability for misuse

---

## About the Author

<div align="center">

```
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │   Adoyi Steven  ·  séç gúy                         │
  │   Cybersecurity Researcher & Penetration Tester     │
  │                                                     │
  │   Bug bounty · Ethical hacking · Enterprise sec     │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

</div>

**Séç Proxy** is built by **Adoyi Steven** (known as *séç gúy*), a cybersecurity researcher and penetration tester focused on building practical, open-source tools for ethical hacking, bug bounty hunting, and enterprise security assessment.

### Other Tools by Adoyi Steven

| Tool | Description | Repository |
|------|-------------|------------|
| **Séç Proxy** | Intercepting HTTP/HTTPS proxy — Burp Suite for Termux | [Steven5233/Sec-proxy](https://github.com/Steven5233/Sec-proxy.git) |
| **Vulnora** | Vulnerability scanner and recon framework | [Steven5233/vulnora](https://github.com/Steven5233/vulnora.git) |
| **BLfinder** | Bug and link finder for web reconnaissance | [Steven5233/BLfinder](https://github.com/Steven5233/BLfinder.git) |

> Building tools that put serious security capabilities in the hands of researchers who need them — whether they're on a desktop workstation or an Android phone in the field.

---

## License

```
MIT License

Copyright (c) 2025 Adoyi Steven (séç gúy)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
```

---

<div align="center">

**Made with ☕ and late nights by séç gúy**

⭐ Star this repo if it helped you · 🐛 Open an issue if something breaks · 🔀 PRs welcome

[![GitHub](https://img.shields.io/badge/GitHub-Steven5233-181717?style=flat-square&logo=github)](https://github.com/Steven5233)
[![Sec-proxy](https://img.shields.io/badge/Sec--proxy-repo-00ff9d?style=flat-square&logo=github&logoColor=white&labelColor=0a0c0f)](https://github.com/Steven5233/Sec-proxy.git)
[![Vulnora](https://img.shields.io/badge/Vulnora-repo-a29bfe?style=flat-square&logo=github&logoColor=white&labelColor=0a0c0f)](https://github.com/Steven5233/vulnora.git)
[![BLfinder](https://img.shields.io/badge/BLfinder-repo-4fc3f7?style=flat-square&logo=github&logoColor=white&labelColor=0a0c0f)](https://github.com/Steven5233/BLfinder.git)

</div>
