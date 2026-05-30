# Host update policy — PersaLink box

PersaLink keeps long-lived tmux sessions alive for days. Anything that restarts
the tmux server or the PM2 daemon hosting it wipes that work. On **2026-05-28**
the daily `unattended-upgrades` run upgraded `libgcrypt20`, and `needrestart`
(in its default auto-restart mode) bounced every service linking the old lib —
PM2 + all apps + the tmux server — silently killing all active `pl-` sessions.

**Policy: no automatic OS updates, ever. Updates are manual and session-gated.**

## What's installed

| Source file | Installed to | Effect |
|---|---|---|
| `needrestart-no-autorestart.conf` | `/etc/needrestart/conf.d/zz-persalink.conf` | needrestart never auto-restarts a service (list-only) |
| `20auto-upgrades` | `/etc/apt/apt.conf.d/20auto-upgrades` | APT periodic update + unattended-upgrade = off |
| `../persalink-update.sh` | `/usr/local/bin/persalink-update` | the only sanctioned update path; refuses while `pl-` sessions are open |

Plus: `apt-daily.timer` and `apt-daily-upgrade.timer` are **masked**.

## Install / re-apply (run from repo root)

```bash
sudo install -m 0644 scripts/host/needrestart-no-autorestart.conf /etc/needrestart/conf.d/zz-persalink.conf
sudo install -m 0644 scripts/host/20auto-upgrades                  /etc/apt/apt.conf.d/20auto-upgrades
sudo install -m 0755 scripts/persalink-update.sh                   /usr/local/bin/persalink-update
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer
sudo systemctl mask           apt-daily.timer apt-daily-upgrade.timer
```

## Updating the box (when you're ready)

```bash
sudo persalink-update   # aborts if any pl- session is open; else upgrades + offers reboot
```

## Session survival across reboots

Updates/needrestart can no longer restart services unprompted — but a *reboot*
(power loss, kernel panic, manual `reboot`) still clears the tmux server. To
make `pl-` sessions come BACK after one, the box runs:

- **`loginctl enable-linger disdiqqq`** — user processes (tmux + PM2) persist
  with no active login session; the user systemd manager runs at boot.
- **tmux-resurrect + tmux-continuum** (via TPM in `~/.tmux.conf`):
  - Auto-saves every 15 min (`@continuum-save-interval 15`), captures pane
    contents (`@resurrect-capture-pane-contents on`).
  - **`@continuum-boot on`** installs a user unit `~/.config/systemd/user/tmux.service`
    (enabled) that starts tmux at boot; **`@continuum-restore on`** then restores
    the last save. Saves land in `~/.local/share/tmux/resurrect/`.
  - `tmux.service` ExecStop runs a resurrect save *before* `kill-server`, so a
    graceful reboot loses zero state; only a hard crash falls back to the last
    15-min auto-save.

Caveat: resurrect restores session/window/pane **layout, cwd, and scrollback** —
it does NOT auto-relaunch arbitrary programs (e.g. `claude`, `ollama`). Panes
come back at a shell prompt in the right directory; re-run the command.

Re-apply on a fresh box: `loginctl enable-linger $USER`, install TPM, ensure the
plugin block in `~/.tmux.conf`, `~/.tmux/plugins/tpm/bin/install_plugins`, then
`~/.tmux/plugins/tmux-continuum/scripts/handle_tmux_automatic_start.sh` (with
`XDG_RUNTIME_DIR=/run/user/$(id -u)` exported).

## Reverting to stock Ubuntu auto-updates

```bash
sudo rm -f /etc/needrestart/conf.d/zz-persalink.conf
sudo systemctl unmask  apt-daily.timer apt-daily-upgrade.timer
sudo systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades
```
