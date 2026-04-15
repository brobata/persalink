# PersaLink — Tmux Session Orchestrator

## Overview

PersaLink is a tmux session orchestrator that provides seamless terminal access from any device via a web browser. The server manages tmux sessions behind a polished UI — users never type tmux commands. Profiles define project environments with auto-commands, quick actions, and health checks.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                PERSALINK SERVER                  │
│              (Node.js, port 9877)                 │
│                                                   │
│  ┌─────────────┐  ┌──────────────┐               │
│  │  Profile     │  │  Tmux        │               │
│  │  Manager     │  │  Manager     │               │
│  │  (JSON file) │  │  (execFile)  │               │
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

## Key Design Decisions

- **Single web app** — one responsive client served to all devices (phone, desktop, tablet)
- Tmux sessions survive server restarts — no lost work
- Each client gets its own PTY bridge to the same tmux session
- Multiple clients can connect simultaneously
- Desktop (≥768px) gets a sidebar layout; mobile gets full-screen view switching

## Project Structure

```
persalink/
├── packages/shared/src/protocol.ts   # Shared types + protocol
├── apps/
│   ├── server/src/
│   │   ├── main/index.ts             # Entry point, WebSocket, auth
│   │   ├── tmuxManager.ts            # ALL tmux interaction
│   │   ├── profileManager.ts         # Profile CRUD + auto-discovery
│   │   ├── healthChecker.ts          # Periodic health checks
│   │   ├── auth.ts                   # Password hashing + tokens
│   │   ├── config.ts                 # ~/.persalink/config.json
│   │   ├── rateLimiter.ts            # Per-IP auth rate limiting
│   │   ├── auditLog.ts              # Structured JSON logging
│   │   ├── atomicWrite.ts           # Crash-safe file writes
│   │   └── httpServer.ts            # Static files + health endpoint
│   └── client/                       # React + Vite (responsive web app)
│       └── src/
│           ├── App.tsx               # Root — desktop sidebar vs mobile views
│           ├── components/
│           │   ├── TerminalScreen.tsx # xterm.js terminal + tab switching
│           │   ├── Sidebar.tsx       # Desktop sidebar (profiles, sessions)
│           │   ├── HomeScreen.tsx     # Session/profile list (mobile)
│           │   ├── ConnectScreen.tsx  # Server URL input
│           │   ├── AuthScreen.tsx     # Password entry
│           │   ├── SettingsScreen.tsx # Server settings
│           │   └── ProfileEditor.tsx  # Profile CRUD form
│           ├── stores/appStore.ts    # Zustand state + WebSocket handler
│           └── lib/
│               ├── ws.ts            # WebSocket client wrapper
│               └── biometric.ts     # Biometric auth (stub for web)
├── ecosystem.config.js               # PM2 config
└── CLAUDE.md
```

## Tech Stack

### Server
- Node.js + TypeScript
- ws (WebSocket)
- node-pty (PTY for tmux attach bridge)
- tmux (session engine, via execFile)

### Client
- React 19 + TypeScript
- Vite 7
- Tailwind CSS 4
- xterm.js (WebGL)
- Zustand (state)
- Responsive design — desktop sidebar at ≥768px, mobile full-screen below

## Config

- **Config dir**: `~/.persalink/`
- **Config file**: `~/.persalink/config.json`
- **Profiles**: `~/.persalink/profiles.json`
- **Tokens**: `~/.persalink/tokens.json`
- **Default port**: 9877
- **PM2 name**: `persalink`

## Development

```bash
# Server
cd apps/server && npm install && npm run build && npm run start

# Client (dev mode with HMR)
cd apps/client && npm install && npm run dev

# Client (production build — served by the server)
cd apps/client && npm run build
```

## Session Naming

All PersaLink tmux sessions are prefixed with `pl-`:
- `pl-myproject` — from profile "myproject"
- `pl-1711234567` — bare session (timestamp ID)

Non-prefixed tmux sessions are never touched by PersaLink.

## Protocol

WebSocket JSON messages. Key flows:

1. **Connect**: client connects → server sends `auth.required` → client sends `auth.token` → server sends `auth.ok` + sessions + profiles
2. **Create session**: client sends `session.create` with profileId → server runs `tmux new-session`, runs on-connect command, auto-attaches
3. **Attach**: client sends `session.attach` → server spawns PTY with `tmux attach -t <session>` → relays I/O
4. **Detach**: client sends `session.detach` → server kills PTY bridge, tmux session keeps running
5. **Tab switch**: client sends `session.attach` (no detach needed — server auto-detaches current bridge)
