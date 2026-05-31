# Séç Proxy — HTTP Repeater

A Burp Suite-style HTTP repeater that runs entirely in the browser.  
Built for use in **Termux** and any modern browser. No backend required.

```
┌─────────────────────────────────────────────┐
│  Séç Proxy v1.0 · Repeater                  │
├──────────────┬──────────────────┬────────────┤
│  Request     │   Response       │  History   │
│  ─────────   │   ──────────     │  ─────── ──│
│  Method/URL  │   Status badge   │  GET  200  │
│  Headers     │   Body (JSON)    │  POST 201  │
│  Params      │   Headers tab    │  ...       │
│  Cookies     │   Raw tab        │            │
│  Body        │                  │            │
└──────────────┴──────────────────┴────────────┘
```

## Features

- **Methods** — GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
- **Headers editor** — add / remove / enable-disable any header
- **Query params** — key-value builder, auto-appended to the URL
- **Cookies** — name=value pairs injected as a `Cookie` header
- **Request body** — JSON, Form-encoded, XML, Raw modes
- **JSON formatter** — pretty-print button + syntax highlighting
- **Response viewer** — Body / Headers / Raw tabs
- **Status badges** — colour-coded 2xx / 3xx / 4xx / 5xx
- **Request history** — last 50 requests, click to reload
- **CORS proxy toggle** — routes through corsproxy.io to bypass browser CORS
- **Drag-to-resize** panels (mouse & touch)
- **Keyboard shortcut** — `Ctrl+Enter` to send
- **Multi-tab** support

## Quick Start

### Option 1 — Open directly in a browser

Just open `index.html` in any browser. No server needed for local files,
though the CORS proxy button helps when the target API blocks cross-origin requests.

### Option 2 — Termux (recommended)

```bash
# Install dependencies
pkg update && pkg install git python

# Clone the repo
git clone https://github.com/Steven5233/Sec-proxy.git
cd sec-proxy

# Serve locally
python -m http.server 8080
```

Then open your Termux browser and go to:
```
http://localhost:8080
```

Or open directly with Termux:
```bash
termux-open index.html
```

### Option 3 — Node.js server (Termux)

```bash
pkg install nodejs
npx serve .
```

## CORS Proxy

When running in a browser, same-origin policy blocks requests to external APIs.
The **⚙ CORS** button in the top bar toggles routing through
[corsproxy.io](https://corsproxy.io) to work around this.

- **CORS ON** → requests go through the proxy (default)
- **CORS OFF** → direct requests (works in Termux with a local server, or APIs that allow `*` origin)

## File Structure

```
sec-proxy/
├── index.html   # Markup & layout
├── style.css    # Dark terminal theme
├── app.js       # All logic (request engine, history, UI)
└── README.md
```

## Keyboard Shortcuts

| Shortcut       | Action      |
|----------------|-------------|
| `Ctrl+Enter`   | Send request|

## License

MIT — do whatever you want with it.
