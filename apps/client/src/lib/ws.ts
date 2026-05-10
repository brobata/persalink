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
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private intentionalClose = false;
  private hasConnectedOnce = false;
  private lastInboundAt = 0;
  private visibilityHandler: (() => void) | null = null;

  // Liveness tuning. The server sends pings on its own cadence; we also send
  // ours every PING_INTERVAL_MS. If we go LIVENESS_TIMEOUT_MS without ANY
  // inbound traffic, we declare the socket a zombie and force-reconnect.
  // 25s ping + 45s timeout means up to 1 missed ping before we tear down —
  // tolerant of brief network blips, but catches the OS-dropped-the-socket
  // case where readyState lies and onclose never fires.
  private readonly PING_INTERVAL_MS = 25_000;
  private readonly LIVENESS_TIMEOUT_MS = 45_000;
  private readonly LIVENESS_CHECK_MS = 5_000;

  constructor(options: WSClientOptions) {
    this.url = options.url;
    this.onMessage = options.onMessage;
    this.onStateChange = options.onStateChange;
  }

  connect(): void {
    this.intentionalClose = false;
    this.onStateChange('connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
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
    this.stopPing();
    this.stopLivenessCheck();
    this.detachVisibilityHandler();
    this.ws?.close();
    this.ws = null;
  }

  updateUrl(url: string): void {
    this.url = url;
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
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
    if (this.visibilityHandler) return;
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      // Tab just came back to focus. If the OS suspended us, the socket
      // may already be dead. Force an immediate liveness check instead of
      // waiting up to LIVENESS_CHECK_MS for the timer to tick.
      this.checkLiveness();
      // Also send a ping so server knows we're alive and so an inbound
      // pong refreshes lastInboundAt for the next liveness window.
      this.send({ type: 'ping' });
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private detachVisibilityHandler(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
}
