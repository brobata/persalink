/**
 * @file WebSocket Client
 * @description Auto-reconnecting WebSocket client for PersaLink server communication.
 *   Handles connection lifecycle, auth, and message routing.
 */

import type { ClientMessage, ServerMessage } from '@persalink/shared/protocol';

export type MessageHandler = (msg: ServerMessage) => void;
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'reconnecting';

interface WSClientOptions {
  url: string;
  onMessage: MessageHandler;
  onStateChange: (state: ConnectionState) => void;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: MessageHandler;
  private onStateChange: (state: ConnectionState) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  // Capped low: on mobile the socket drops often, and a 30s backoff left users
  // staring at "Connecting…" (or force-closing the app). 6s ceiling keeps
  // retries brisk; foregrounding/online events reset it to 0 anyway.
  private maxReconnectDelay = 6000;
  private intentionalClose = false;
  private hasConnectedOnce = false;
  private lastInboundAt = 0;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;

  // Liveness tuning. We ping every PING_INTERVAL_MS; if we go
  // LIVENESS_TIMEOUT_MS without ANY inbound traffic, the socket is a zombie and
  // we force-reconnect. The server broadcasts sessions.list every ~4s, so a
  // healthy socket never approaches 15s of silence — a dead one is caught fast,
  // while still tolerating a brief blip. (readyState lies and onclose often
  // never fires when a mobile OS drops a backgrounded socket.)
  private readonly PING_INTERVAL_MS = 10_000;
  private readonly LIVENESS_TIMEOUT_MS = 15_000;
  private readonly LIVENESS_CHECK_MS = 3_000;
  // Bound the CONNECTING phase. `new WebSocket()` to an unreachable host (e.g. a
  // cold Tailscale tunnel on Android app launch) can sit in CONNECTING for the
  // OS TCP timeout — 30-120s — without ever firing onopen or onclose. The
  // liveness check doesn't help: it only starts after onopen. Without this
  // watchdog the very first connect after a cold launch pins the UI on
  // "Connecting…" with nothing scheduling a retry (no visibilitychange fires on
  // an already-visible fresh launch). 8s is far above a warm handshake (<1s).
  private readonly CONNECT_TIMEOUT_MS = 8_000;

  constructor(options: WSClientOptions) {
    this.url = options.url;
    this.onMessage = options.onMessage;
    this.onStateChange = options.onStateChange;
  }

  connect(): void {
    this.intentionalClose = false;
    this.onStateChange('connecting');
    // Always-on so foregrounding/network-return can force a reconnect even when
    // a connect attempt is stuck and onopen never fired. Idempotent.
    this.attachVisibilityHandler();

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.startConnectWatchdog();

    this.ws.onopen = () => {
      this.clearConnectWatchdog();
      this.reconnectDelay = 1000;
      this.hasConnectedOnce = true;
      this.lastInboundAt = Date.now();
      this.onStateChange('connected');
      this.startPing();
      this.startLivenessCheck();
      this.attachVisibilityHandler();
    };

    this.ws.onmessage = (event) => {
      this.lastInboundAt = Date.now();
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.onMessage(msg);
      } catch (err) {
        // Don't silently drop — protocol drift between client/server shows
        // up here and is otherwise invisible.
        const preview = typeof event.data === 'string' ? event.data.slice(0, 200) : '<binary>';
        console.warn('[ws] malformed message dropped:', err, 'preview:', preview);
      }
    };

    this.ws.onclose = (event) => {
      this.clearConnectWatchdog();
      this.stopPing();
      this.stopLivenessCheck();

      // Server-initiated explicit closes (auth rejected, password changed,
      // origin denied) use 4xxx codes. Don't reconnect into a permanent
      // failure — the appStore handles re-auth via the auth.failed message.
      // Standard close codes 1000 (normal) and 1001 (going away) likewise
      // shouldn't trigger reconnect from a clean disconnect() call.
      const isAuthFailureClose = event.code >= 4000 && event.code < 5000;

      if (this.intentionalClose || isAuthFailureClose) {
        this.onStateChange('disconnected');
        return;
      }

      if (this.hasConnectedOnce) {
        this.onStateChange('reconnecting');
      } else {
        this.onStateChange('disconnected');
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectWatchdog();
    this.stopPing();
    this.stopLivenessCheck();
    this.detachVisibilityHandler();
    this.ws?.close();
    this.ws = null;
  }

  updateUrl(url: string): void {
    this.url = url;
  }

  /**
   * Watch a CONNECTING socket and give up if it never opens. A stalled connect
   * (dead/cold tunnel) otherwise hangs in CONNECTING silently — see
   * CONNECT_TIMEOUT_MS. On expiry we tear the zombie socket down and retry with
   * normal backoff, so the moment the network/tunnel is reachable a retry lands.
   */
  private startConnectWatchdog(): void {
    this.clearConnectWatchdog();
    this.connectTimer = setTimeout(() => {
      if (this.intentionalClose) return;
      if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING) return;
      console.warn('[ws] connect stalled in CONNECTING, aborting and retrying');
      // Detach handlers so the doomed socket's late onclose can't race the new
      // connect (same guard as forceReconnect).
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
      // Keep 'connecting' if we've never been up (an honest "still trying"),
      // else 'reconnecting' so the overlay reflects a dropped live session.
      this.onStateChange(this.hasConnectedOnce ? 'reconnecting' : 'connecting');
      this.scheduleReconnect();
    }, this.CONNECT_TIMEOUT_MS);
  }

  private clearConnectWatchdog(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    // Jitter the wait so multiple sockets don't retry in lockstep. A desktop
    // grid runs one WSClient per pane (up to ~5) plus the store's; without
    // jitter, on a server restart they all start from the same base delay and
    // multiply by the same 1.5 in unison, hammering the server in synchronized
    // bursts. Randomize the actual sleep 0.5×–1.5× while advancing backoff from
    // the (un-jittered) base so the ceiling still holds.
    const jitter = 0.5 + Math.random();
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay * jitter);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
  }

  /**
   * Reconnect NOW, resetting backoff and tearing down any existing socket.
   * Used when the app is foregrounded or the network returns — we never want
   * the user to wait out a backoff timer (the thing that made them force-close
   * the app to "wake it up"). The old socket's handlers are detached first so
   * its onclose can't race a competing reconnect.
   */
  forceReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearConnectWatchdog();
    this.reconnectDelay = 1000;
    this.stopPing();
    this.stopLivenessCheck();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connect();
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, this.PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startLivenessCheck(): void {
    this.livenessTimer = setInterval(() => this.checkLiveness(), this.LIVENESS_CHECK_MS);
  }

  private stopLivenessCheck(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /**
   * Detect zombie sockets: ws.readyState says OPEN but no traffic has
   * arrived in LIVENESS_TIMEOUT_MS. This happens on Android/iOS when the
   * OS suspends the JS context and silently drops the underlying TCP
   * connection — onclose never fires, so the only way out is to notice
   * the silence and tear down ourselves. close() triggers onclose, which
   * triggers our existing reconnect logic.
   */
  private checkLiveness(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const silentMs = Date.now() - this.lastInboundAt;
    if (silentMs > this.LIVENESS_TIMEOUT_MS) {
      console.warn(`[ws] zombie detected: ${silentMs}ms since last inbound, forcing close`);
      try { this.ws.close(); } catch { /* ignore — close will fire anyway */ }
    }
  }

  private attachVisibilityHandler(): void {
    if (!this.visibilityHandler) {
      this.visibilityHandler = () => {
        if (document.visibilityState !== 'visible') return;
        // Back to the foreground. Mobile OSes routinely kill backgrounded
        // sockets WITHOUT firing onclose, so readyState can't be trusted. If
        // we're not cleanly OPEN, reconnect immediately — no backoff wait.
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.forceReconnect();
          return;
        }
        // Socket claims OPEN — but mobile readyState lies (see above). The
        // server broadcasts sessions.list every ~4s, so a genuinely-live
        // foregrounded socket has had inbound traffic very recently. If it's
        // been silent past the liveness timeout, it's a zombie from being
        // backgrounded — reconnect NOW instead of paying a ping round-trip
        // plus a multi-second grace wait (the "stuck on Connecting…" stall
        // after the phone was asleep).
        if (Date.now() - this.lastInboundAt > this.LIVENESS_TIMEOUT_MS) {
          this.forceReconnect();
          return;
        }
        // Recently active but ambiguous (e.g. a quick tab switch). Prove the
        // socket with a ping; if no inbound (pong / sessions.list) lands
        // within a short grace, treat it as a zombie and reconnect.
        this.send({ type: 'ping' });
        setTimeout(() => {
          if (
            document.visibilityState === 'visible' &&
            !this.intentionalClose &&
            Date.now() - this.lastInboundAt > 1500
          ) {
            this.forceReconnect();
          }
        }, 1500);
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    // The network coming back is an equally strong signal to reconnect now.
    if (!this.onlineHandler) {
      this.onlineHandler = () => {
        if (!this.intentionalClose && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
          this.forceReconnect();
        }
      };
      window.addEventListener('online', this.onlineHandler);
    }
  }

  private detachVisibilityHandler(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
  }
}
