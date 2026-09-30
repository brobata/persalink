# Public Remote Access (no VPN) — `term.brobata.com`

**Status:** PLANNED, TABLED 2026-09-23 — owner is thinking it over. Nothing built.
**Origin:** sketch archplan 2026-09-23 ("access PersaLink from my work computer —
can't install a VPN, would go to a website and log in").
**Decided so far:** host it on the **brobata.com** domain behind a secure login.
**2026-09-24:** owner OK'd moving brobata.com DNS to Cloudflare (it was only left on
GoDaddy out of inertia) — Phase 0 is unblocked and can happen independently of the rest.

## The Ask

Reach PersaLink from a locked-down work computer: open a website, log in, get the
terminals. No VPN client, no installs.

## The Insight

Reachability is the easy part. What is actually being published is **a login page
in front of a root-equivalent shell** on the box that holds the prod Supabase service
key, Stripe work and every repo. So the design is about (1) making sure nobody else
ever reaches the PersaLink login, and (2) treating the work computer as an
**untrusted device** — it may be monitored, its traffic may be TLS-inspected, and
whatever the browser stores stays there.

Today PersaLink is tailnet-only (`tailscale serve` → `localhost:9877`), and its only
lock is its own password. That is fine behind Tailscale and too thin on the internet.

## Recommended Approach 🟢 — Cloudflare Tunnel + Cloudflare Access on `term.brobata.com`

```
Work PC browser
  └─HTTPS─▶ Cloudflare edge
              └─ Cloudflare Access  (Brobata-branded login; Google sign-in,
                 allowlist = the owner's email only; 12h session)
                   └─ Tunnel (outbound-only from the box) ─▶ cloudflared (pm2)
                        └─▶ 127.0.0.1:9878   ← NEW "public door" listener
                              • rejects anything without a valid Cf-Access-Jwt-Assertion
                              • client IP = CF-Connecting-IP
                              • first-run password setup permanently disabled
                              • issues session-only 12h tokens
                              └─▶ same PersaLink core (auth, tmux, sessions)

Tailnet devices ─▶ tailscale serve ─▶ 127.0.0.1:9877   (UNCHANGED daily driver)
```

What the owner sees from work: `https://term.brobata.com` → Brobata-branded sign-in
(Google, with Google's own 2-step) → PersaLink password → sessions.

**Two independent locks:** Cloudflare Access identity (+ Google MFA) must pass
before a single byte reaches PersaLink; then PersaLink's own scrypt password.

### Alternatives Considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **CF Tunnel + Access on brobata.com** | Identity wall in front, MFA via Google, no open ports, home IP hidden, free (≤50 users), WebSockets native, branded login | brobata.com DNS must move to Cloudflare (see Phase 0) | 🟢 Recommended |
| Tailscale Funnel | One command, already installed | No custom domain (`*.ts.net` only, so can't be brobata.com); public page guarded **only** by the PersaLink password; ts.net more likely filtered by corporate proxies | 🟡 Stopgap only |
| Port-forward + Caddy + Let's Encrypt, `A term.brobata.com` at GoDaddy | Keeps DNS at GoDaddy | Exposes home IP, router config, bot/DDoS traffic lands on the box, identity wall is ours to build | 🔴 Avoid |
| Use Brobata's Supabase Auth as the login | "Brobata login" literally | Makes the **prod app database** the gate to a root shell — an app-auth bug or leaked service key becomes shell access; couples a personal tool to the product | 🔴 Avoid |
| Relay through Vercel | Reuses infra | Functions aren't a terminal proxy; toy-grade | 🔴 Avoid |

## The Design

### Phase 0 — Move brobata.com DNS to Cloudflare (the one real prerequisite)

A Cloudflare Tunnel hostname needs the zone on Cloudflare; the free plan can't
delegate just a subdomain. brobata.com is currently on GoDaddy
(`ns61/ns62.domaincontrol.com`). The registrar stays GoDaddy — only nameservers move.
freefoodcost.com / apron-ops.com / cater-ops.com have already been moved, so this has
been done before.

Records observed publicly (2026-09-23) that MUST survive the move — export the full
zone from GoDaddy first; dig can't enumerate everything:

| Record | Value | Notes |
|---|---|---|
| `A @` | 216.198.79.1 | Vercel apex → **DNS-only (grey cloud)** |
| `CNAME www` | `…vercel-dns-017.com` | Vercel → **DNS-only** |
| `MX @` | Google Workspace (aspmx + alt1–4) | Mail — must be exact |
| `TXT @` | `v=spf1 include:resend.com include:amazonses.com ~all` | see side-finding below |
| `TXT @` | google-site-verification | keep |
| `TXT _dmarc` | `p=quarantine; rua=…@onsecureserver.net` | GoDaddy-hosted report address; keep or repoint |
| `TXT resend._domainkey` | Resend DKIM | keep |
| (unknown) | Resend `send.` MX/SPF, Google DKIM `google._domainkey`, any others | **from the GoDaddy export** |

Procedure: add zone in Cloudflare → let it scan → diff against the GoDaddy export
record-by-record → set every existing record **DNS-only** (don't proxy Vercel) →
lower TTLs at GoDaddy a day before → switch nameservers → verify site, send/receive
mail, Resend send, DMARC.

> **Side-finding (independent of this plan):** the SPF record authorises Resend and
> SES but **not Google** (`include:_spf.google.com`), while MX is Google Workspace.
> Mail sent from a brobata.com Gmail account may soft-fail SPF (DKIM likely still
> saves it). Worth fixing during the migration.

### Phase 1 — Tunnel + Access (config, no code)

- `cloudflared` installed, tunnel created, run under **pm2** (`cloudflared-term`)
  — house convention, survives reboots; config in `~/.cloudflared/`.
- Tunnel ingress: `term.brobata.com → http://127.0.0.1:9878`; catch-all `http_status:404`.
- Zero Trust → Access application `term.brobata.com`:
  - Identity: Google (owner's account); One-time PIN as break-glass only if desired.
  - Policy: **Allow — emails is exactly the owner's address.** No "everyone", ever,
    even while testing (the origin JWT check is the backstop if it happens).
  - Session duration **12h**; enable "binding cookie"; WebSockets on.
  - **Custom login page:** Brobata logo, name, colours — this is the "secure
    Brobata login" the owner sees.
- Record the **team domain** and the application **AUD tag** → PersaLink config.

### Phase 2 — Server: the public door

1. **Config** (`config.ts`):
   ```ts
   publicListener: {
     enabled: boolean;              // default false
     port: number;                  // 9878, always bound to 127.0.0.1
     accessTeamDomain: string;      // e.g. "brobata.cloudflareaccess.com"
     accessAud: string;             // Access application AUD tag
     allowedEmails: string[];       // must match the Access policy
     sessionTokenTtlHours: number;  // 12
     disableFiles: boolean;         // hide upload/files on this door (default true)
   } | null
   ```
   Refuse to start the public listener if any field is missing — fail closed, never
   open.
2. **Access JWT verification** — new `accessJwt.ts`: verify `Cf-Access-Jwt-Assertion`
   (header, or `CF_Authorization` cookie on the WS upgrade) against
   `https://<team>/cdn-cgi/access/certs` — RS256, `aud` = accessAud, `iss` = team
   domain, `exp`/`nbf`, `email ∈ allowedEmails`. Cache JWKS (1h, refetch on unknown
   `kid`). Invalid/missing → HTTP 403 before any PersaLink handling, on both static
   and WS upgrade paths. Use `jose` (well-tested; don't hand-roll).
3. **Door-aware request handling** (`main/index.ts`): each connection is tagged
   `door: 'tailnet' | 'public'` by which listener accepted it.
   - Public door client IP = `CF-Connecting-IP` (set by Cloudflare, not spoofable
     through the tunnel).
   - Public door: first-run setup **always refused**, regardless of `allowRemoteSetup`
     (every tunnel connection arrives from 127.0.0.1, which would otherwise satisfy
     the localhost setup guard).
4. **Token doors + TTL** (`auth.ts`): tokens carry the door that minted them.
   Public-door tokens expire in `sessionTokenTtlHours`; the public door **rejects
   tailnet-minted tokens** (a stolen 365-day token can't be replayed from the
   internet) and the tailnet door accepts only tailnet tokens (keeps the model symmetric
   and simple).
5. **File endpoints** — when `disableFiles`, `/api/upload`, `/api/files/*` return 403
   on the public door and the client hides those surfaces.
6. **Audit** (`auditLog.ts`): every auth event records `door` and, on the public
   door, the Access `email`.

**Latent bug to fix regardless:** `resolveClientIp` trusts the **first**
`X-Forwarded-For` entry when `trustProxy` is on — that entry is client-controlled, so
rate limiting can be dodged by spoofing it. Take the right-most untrusted hop (or a
provider header). Currently off (`trustProxy: false`), so not exploitable today.

### Phase 3 — Client

- **"This is a shared / work computer" mode**, on automatically when the page is
  served from the public host:
  - token kept in memory/`sessionStorage` only — gone when the browser closes
  - server registry, token, and last-session state are **not** persisted to
    `localStorage` on that machine
  - a visible **PUBLIC** chip in the header so the owner always knows which door
    they're on
  - explicit "Sign out" that also hits `/cdn-cgi/access/logout`
- Upload/Files buttons hidden when the server reports `disableFiles` for this door.
- Access session expiry mid-use: the live WS survives; on reconnect a 403/redirect
  means "Cloudflare sign-in expired" → show a **Sign in again** button (full-page
  navigation to re-run Access), never an endless spinner.
- WS upgrade blocked by a corporate proxy → explicit "Your network is blocking
  WebSocket connections" message.

### Edge Cases

| Case | Behaviour |
|---|---|
| Work proxy blocks brobata.com / Cloudflare Access | Found in the Day-1 probe before any code is written |
| Proxy strips WS upgrades | Clear error; no fallback (long-polling a terminal isn't worth it) |
| Work proxy does TLS inspection | Undetectable from the page — assume employer can read the session; don't type secrets from work |
| Access session expires mid-session | Live connection continues; reconnect prompts re-sign-in |
| Tunnel/cloudflared down | Cloudflare error page; tailnet access unaffected |
| Access policy accidentally widened | Origin JWT `email ∈ allowedEmails` check still refuses |
| Google account compromised | Revoke in Access / Google; PersaLink password still stands |
| PersaLink config lost / password unset | Public door refuses setup; only localhost-via-tailnet or the box itself can set it |
| Box reboot | pm2 restores persalink + cloudflared |

### Security & Compliance

- Two independent auth layers; MFA via Google on the outer one.
- No inbound ports on the router; home IP never published.
- Public door is loopback-bound and only reachable via the tunnel.
- Session-scoped, short-lived tokens on untrusted devices; no persisted secrets.
- Audit trail of every public-door login with identity.
- ⚠️ **Employer policy:** a personal remote shell from a work machine may violate
  acceptable-use rules — owner's call; a reason to keep the public door bare
  (`disableFiles: true`).

## Pre-mortem

1. **Access policy gets loosened** (e.g. "everyone" while testing) → internet reaches
   the PersaLink login. *Guardrail:* origin verifies the Access JWT's `aud` + email
   allowlist independently of the dashboard.
2. **Config wiped → password unset → a stranger claims it through the tunnel.**
   *Guardrail:* public door never permits first-run setup.
3. **A long-lived token left on the work PC** is replayable for a year. *Guardrail:*
   session-only 12h public tokens; tailnet tokens rejected on the public door.
4. **DNS migration breaks brobata.com email or site.** *Guardrail:* full GoDaddy
   zone export + record-by-record diff, DNS-only for Vercel records, lowered TTLs,
   same-hour mail/site verification (Phase 0 checklist).

## Implementation Plan

### Day-1 probe (before any code, ~15 min)
Quick tunnel (`cloudflared tunnel --url http://localhost:<hello>`) serving a page that
opens a WebSocket echo → open it from the work PC. Proves: domain not blocked,
WebSockets survive the corporate proxy. If this fails, stop — nothing else matters.

### Files to Create/Modify
| File | Change |
|---|---|
| `apps/server/src/config.ts` | `publicListener` block + validation (fail closed) |
| `apps/server/src/accessJwt.ts` | NEW — JWKS fetch/cache + JWT verification (`jose`) |
| `apps/server/src/main/index.ts` | second listener, door tagging, CF-Connecting-IP, setup guard, XFF fix |
| `apps/server/src/httpServer.ts` | JWT gate on static + `/api/*`; `disableFiles` 403s |
| `apps/server/src/auth.ts` | token `door` + per-door TTL + cross-door rejection |
| `apps/server/src/auditLog.ts` | `door`, `email` fields |
| `packages/shared/src/protocol.ts` | `auth.ok` carries `door`, `disableFiles`, `tokenExpiresAt` |
| `apps/client/src/stores/appStore.ts` | session-only persistence mode |
| `apps/client/src/components/AuthScreen.tsx` | shared-computer mode, sign-out |
| `apps/client/src/components/TerminalScreen.tsx`, `TerminalPane.tsx` | PUBLIC chip, hide upload when disabled |
| tests (server) | JWT valid/expired/wrong-aud/bad-sig/wrong-email; cross-door token rejection; setup guard; IP resolution |
| `ecosystem.config.js` | `cloudflared-term` process |
| `CLAUDE.md` | document the two doors |

### Build Order
- [ ] Day-1 probe from the work PC
- [ ] Phase 0 — brobata.com zone export → Cloudflare → NS switch → verify mail/site (+ SPF fix)
- [ ] Phase 1 — named tunnel on pm2, Access app + branded login, grab AUD
- [ ] Phase 2 — `accessJwt.ts` + tests → public listener + door tagging → token doors → file gating → audit
- [ ] Phase 3 — client shared-computer mode, PUBLIC chip, re-sign-in + WS-blocked UX
- [ ] End-to-end from the work PC; confirm tailnet path unchanged

### Estimated Complexity
**Medium.** Tunnel/Access is config; the DNS move is careful-not-hard; the real code
is the JWT gate and door-aware tokens (~1 focused session + tests).

## Decision Log

- **brobata.com over a dedicated domain** — owner preference (2026-09-23); DNS move to
  Cloudflare approved 2026-09-24. Cost: the
  zone moves to Cloudflare, and `term.brobata.com` appears in public certificate
  transparency logs (harmless with the Access wall in front).
- **Cloudflare Access over Funnel** — an identity wall *in front of* the app beats
  one password on a public page; Funnel also can't do a custom domain.
- **Cloudflare Access over Supabase Auth** — the product DB must never be the key to
  the shell.
- **Separate loopback port over single-port detection** — tailnet and tunnel both
  arrive from localhost; only a separate listener tells them apart safely, and it
  leaves the daily driver untouched.
- **Session-only tokens on the public door** — the work PC isn't the owner's device.
- **Files disabled on the public door by default** — narrowest exfiltration surface
  from an untrusted machine.
