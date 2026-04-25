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
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private intentionalClose = false;
  private hasConnectedOnce = false;

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
      this.onStateChange('connected');
      this.startPing();
    };

    this.ws.onmessage = (event) => {
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
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
