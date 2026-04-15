# PersaLink

Tmux session orchestrator — manage terminal sessions from any device through your browser.

PersaLink runs a lightweight server on your machine that bridges tmux sessions to a responsive web UI. Connect from your phone, tablet, or any browser to access your terminal sessions without SSH clients or VPN hassle.

## Features

- **Multi-device access** — One responsive web app works on desktop (sidebar layout) and mobile (full-screen)
- **Session persistence** — Tmux sessions survive server restarts, network drops, and device switches
- **Profile system** — Define project environments with auto-commands, quick actions, and health checks
- **Auto-discovery** — Scans `~/projects` and creates profiles automatically
- **Multi-session tabs** — Multiple terminal sessions open simultaneously
- **Multi-window support** — Tmux windows within each session, with tab switching
- **File upload** — Upload files from your device directly into the terminal
- **Secure auth** — scrypt password hashing, token-based persistent login, rate limiting
- **Auto-reconnect** — Transparent reconnection on network drops
- **WebGL rendering** — Hardware-accelerated terminal with 10K line scrollback

## Quick Start

### Prerequisites

- **Node.js** 20+
- **tmux** installed (`apt install tmux` / `brew install tmux`)
- **npm** 8+

### Install

**From npm** (easiest):

```bash
npm install -g persalink
persalink
```

**One-line installer** (no npm required):

```bash
curl -fsSL https://github.com/brobata/persalink/releases/latest/download/setup.sh | bash
```

**From source** (for development):

```bash
git clone https://github.com/brobata/persalink.git
cd persalink
npm install
npm run build:server
npm run build:client
npm run start:server
```

### Connect

Open `http://<your-server-ip>:9877` in any browser. Set a password on first connect — that's it.

### Run with PM2 (recommended for long-running servers)

```bash
npm install -g pm2
pm2 start persalink --name persalink
pm2 save
pm2 startup  # auto-start on boot
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│                PERSALINK SERVER                  │
│              (Node.js, port 9877)                 │
│                                                   │
│  ┌─────────────┐  ┌──────────────┐               │
│  │  Profile     │  │  Tmux        │               │
│  │  Manager     │  │  Manager     │               │
│  └──────────────┘  └──────────────┘               │
│  ┌─────────────┐  ┌──────────────┐               │
│  │  Health      │  │  WebSocket   │               │
│  │  Checker     │  │  Server      │               │
│  └──────────────┘  └──────────────┘               │
│  ┌──────────────────────────────────┐             │
│  │  Auth (scrypt + token store)     │             │
│  └──────────────────────────────────┘             │
│  ┌──────────────────────────────────┐             │
│  │  Static file server (client UI)  │             │
│  └──────────────────────────────────┘             │
└──────────────────────────────────────────────────┘
         ▲              ▲              ▲
    Phone browser   Desktop browser   Any browser
```

Each client connects via WebSocket. The server spawns a PTY bridge to `tmux attach` for the selected session, relaying terminal I/O in real-time. Multiple clients can view the same session simultaneously.

## Configuration

All config lives in `~/.persalink/`:

| File | Purpose |
|------|---------|
| `config.json` | Server settings (port, name, security) |
| `profiles.json` | Session profiles (auto-generated + manual) |
| `tokens.json` | Auth tokens (hashed, not plaintext) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PERSALINK_PORT` | `9877` | Server port |
| `PERSALINK_CONFIG_DIR` | `~/.persalink` | Config directory |
| `NODE_ENV` | `development` | Set to `production` for PM2 |

## Profiles

Profiles define terminal environments. Each profile can have:

- **Working directory** — Where the session starts
- **On-connect command** — Run when the session is created (e.g., `npm run dev`)
- **Quick actions** — One-click commands (e.g., "Git Pull", "Run Tests")
- **Health checks** — Periodic checks with parsed output (e.g., `docker ps`)
- **Group, icon, color** — Visual organization

PersaLink auto-discovers projects in `~/projects` on first launch and creates profiles for each.

## Security

### What's built in

- **Password hashing**: scrypt (N=16384, r=8, p=1) with random salt
- **Token auth**: 256-bit random tokens, SHA-256 hashed for storage
- **Rate limiting**: 5 failed attempts = 15 minute lockout per IP
- **Auth timeout**: 30 seconds to authenticate after connecting
- **File permissions**: Config dir `0700`, token file `0600`
- **Security headers**: CSP, X-Frame-Options, X-Content-Type-Options
- **Path traversal protection**: Static file server validates all paths
- **Audit logging**: All auth events logged to structured JSON

### What you should add

PersaLink listens on plain HTTP. For access beyond your local network:

**Use a reverse proxy with TLS** (recommended):

```nginx
# /etc/nginx/sites-available/persalink
server {
    listen 443 ssl;
    server_name terminal.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:9877;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Or with **Caddy** (automatic TLS):

```
terminal.yourdomain.com {
    reverse_proxy 127.0.0.1:9877
}
```

When using a reverse proxy, set `trustProxy: true` in `~/.persalink/config.json` so rate limiting uses the real client IP.

## Development

```bash
# Server (watch mode)
cd apps/server && npm run dev

# Client (Vite HMR)
cd apps/client && npm run dev

# Client production build (served by the server)
cd apps/client && npm run build
```

## Project Structure

```
persalink/
├── packages/shared/         # Shared types + WebSocket protocol
├── apps/
│   ├── server/src/
│   │   ├── main/index.ts    # Entry point, WebSocket, auth
│   │   ├── tmuxManager.ts   # All tmux interaction
│   │   ├── profileManager.ts # Profile CRUD + auto-discovery
│   │   ├── healthChecker.ts # Periodic health checks
│   │   ├── auth.ts          # Password hashing + tokens
│   │   ├── config.ts        # Server configuration
│   │   ├── rateLimiter.ts   # Per-IP auth rate limiting
│   │   ├── auditLog.ts      # Structured JSON logging
│   │   └── httpServer.ts    # Static files + API endpoints
│   └── client/src/
│       ├── App.tsx           # Root — desktop sidebar vs mobile
│       ├── components/       # React components
│       ├── stores/           # Zustand state + WebSocket
│       └── lib/              # WebSocket client, utilities
├── ecosystem.config.js       # PM2 config
└── package.json
```

## Tech Stack

**Server**: Node.js, TypeScript, ws (WebSocket), node-pty
**Client**: React 19, Vite, Tailwind CSS 4, xterm.js (WebGL), Zustand

## License

[MIT](LICENSE)
