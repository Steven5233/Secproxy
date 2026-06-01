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

[Features](#features) · [Installation](#installation) · [Usage](#usage) · [HTTPS Setup](#https-interception-setup) · [API Reference](#rest-api-reference) · [Author](#about-the-author)

<br>

</div>

---

## What is Séç Proxy?

Séç Proxy is a full-featured intercepting proxy tool inspired by Burp Suite Community Edition, written entirely in **Node.js** with a browser-based UI. It sits between your browser/app and the internet, giving you complete visibility and control over every HTTP and HTTPS request — intercept, inspect, edit, replay, and scan traffic in real time.

Built specifically to run on **Termux (Android)** with zero configuration, while also shipping with a full **Electron-based built-in browser** for desktop use that routes traffic through the proxy automatically — no manual proxy settings required.

Designed for ethical hacking, bug bounty hunting, CTF challenges, and security research.

---

## Features

### Core Proxy Engine
- **HTTP & HTTPS interception** — full MITM via dynamic CA certificate generation (node-forge)
- **WebSocket real-time push** — every captured request/response appears in the UI instantly
- **SQLite persistence** — complete request history survives restarts
- **Match & Replace rules** — auto-modify requests and responses in-flight using literal or regex patterns
- **Intercept rules** — filter exactly which requests to pause (by host, URL, method, body)

### Built-in Browser (Desktop)
- **Electron window** pre-configured to route all traffic through the proxy — zero setup
- **Floating address bar** injected into every page (back, forward, reload, URL input, HTTPS indicator)
- **Certificate trust bypass** — the built-in browser automatically trusts the generated CA

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
│   └── browser-preload.js      ← Injects address bar into target browser
│
├── server/                      ← Node.js proxy engine
│   ├── proxy.js                 ← HTTP listener + REST API  (:8080)
│   ├── mitm.js                  ← HTTPS MITM via CONNECT hijack + TLS unwrap
│   ├── ca.js                    ← Root CA generator + per-host cert factory
│   ├── db.js                    ← SQLite schema + all prepared statements
│   ├── intercept.js             ← Pause / forward / drop engine (singleton)
│   ├── scanner.js               ← Passive security scanner (16 checks)
│   ├── ws-bridge.js             ← WebSocket real-time push to UI  (:8081)
│   └── ca/                      ← Auto-generated CA files (git-ignored)
│       ├── ca.key.pem
│       ├── ca.cert.pem
│       └── secproxy-ca.crt     ← Install this on Android / browser
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
| Python 3 | any | Required for Termux UI server only |
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
pkg install nodejs python git -y

# Clone the repository
git clone https://github.com/Steven5233/Sec-proxy.git
cd Sec-proxy

# Launch (installs npm deps automatically on first run)
bash start.sh
```

The launcher will:
1. Install npm dependencies if missing
2. Start the proxy server on `:8080`
3. Start the UI static server on `:3000`
4. Open `http://127.0.0.1:3000` in your default browser automatically

---

### Headless / CI (no Electron)

```bash
# Proxy server only
npm run start:proxy

# Proxy + static UI server
npm run start:nogui
```

Then open `http://127.0.0.1:3000` in any browser.

---

## Usage

### Termux — Step-by-step

#### 1. Start the proxy
```bash
bash start.sh
```

#### 2. Configure Firefox to use the proxy
```
Settings → General → Network Settings → Manual proxy configuration
HTTP Proxy:   127.0.0.1     Port: 8080
☑ Also use this proxy for HTTPS
```

#### 3. Browse normally — all traffic appears in the Proxy tab in real time

#### 4. Enable intercept to pause and edit requests before they are sent
```
Click "Intercept OFF" button in the top bar → becomes "Intercept ON"
```

---

### Desktop — Zero configuration

```bash
npm start
```

The built-in browser window is already routed through the proxy. Start browsing immediately.

---

### Custom ports

```bash
PROXY_PORT=9090 WS_PORT=9091 UI_PORT=4000 bash start.sh
```

---

## HTTPS Interception Setup

Séç Proxy generates a local root CA on first launch and signs per-hostname certificates on the fly, exactly like Burp Suite.

### Step 1 — Download the CA certificate

After starting the proxy, go to the **Settings** tab → click **"Download CA Cert"**

Or fetch it directly:
```
http://127.0.0.1:8080/api/ca.crt
```

### Step 2 — Install on Android

```
1. Transfer secproxy-ca.crt to your device
2. Settings → Security → Encryption & credentials
3. Install a certificate → CA certificate
4. Select secproxy-ca.crt
5. Name it: SecProxy
```

### Step 3 — Install on Desktop browsers

**Firefox:**
```
Settings → Privacy & Security → Certificates → View Certificates
→ Authorities tab → Import → select secproxy-ca.crt
→ Check: Trust this CA to identify websites
```

**Chrome / Chromium:**
```
Settings → Privacy & Security → Security → Manage certificates
→ Authorities → Import → select secproxy-ca.crt
→ Trust for identifying websites
```

**macOS system-wide:**
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain secproxy-ca.crt
```

> **Certificate pinning note:** Apps that implement SSL/TLS certificate pinning (most banking, payment, and government apps) will reject the MITM cert and fail to connect. Bypassing certificate pinning requires additional tooling (Frida, Magisk + TrustMeAlready) and is outside the scope of this tool.

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

---

## Troubleshooting

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
- Make sure you installed the CA certificate correctly
- Restart your browser after installing the cert
- In Firefox, ensure "Also use this proxy for HTTPS" is checked

**App traffic not intercepted on Android:**
- Set the Wi-Fi proxy on your device to the Termux device's LAN IP (shown at startup) and port `8080`
- Some apps ignore the Wi-Fi proxy — use `adb` or VPN-based approaches for those

**WebSocket not connecting (dot stays red):**
- Check that the proxy server started successfully
- Confirm port `8081` is not blocked by a firewall
- Try refreshing the UI page

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
