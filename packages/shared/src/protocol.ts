/**
 * @file PersaLink Protocol v1
 * @description Shared types for tmux session orchestrator communication.
 *   PersaLink uses tmux as the session engine for persistent terminal sessions.
 *   Sessions survive server restarts. Profiles define project environments
 *   with on-connect automation, quick actions, and health checks.
 */

// ============================================================================
// Profiles
// ============================================================================

export interface QuickAction {
  id: string;
  name: string;
  command: string;
  icon?: string;
  confirm?: boolean;
}

export interface HealthCheck {
  command: string;
  intervalSeconds: number;
  parser: 'exit-code' | 'json' | 'contains';
  /** For 'contains' parser: string to search for in output */
  contains?: string;
}

export interface Profile {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  cwd?: string;
  command?: string;
  shell?: string;
  env?: Record<string, string>;
  group?: string;
  pinned?: boolean;
  actions?: QuickAction[];
  healthCheck?: HealthCheck;
  cols?: number;
  rows?: number;
}

// ============================================================================
// Tmux Sessions
// ============================================================================

export interface TmuxWindowInfo {
  index: number;
  name: string;
  active: boolean;
  paneCount: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  profileId?: string;
  profileName?: string;
  profileColor?: string;
  profileIcon?: string;
  windows: TmuxWindowInfo[];
  createdAt: number;
  attached: boolean;
  /** Seconds since last activity */
  idleSeconds?: number;
}

export interface HealthStatus {
  profileId: string;
  healthy: boolean;
  lastCheck: number;
  output?: string;
}

// ============================================================================
// Token Info
// ============================================================================

export interface TokenInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
}

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type ClientMessage =
  // Auth
  | { type: 'auth'; password: string; tokenName?: string }
  | { type: 'auth.token'; token: string }
  // Token management
  | { type: 'token.list' }
  | { type: 'token.create'; name: string; ttlDays?: number | null }
  | { type: 'token.revoke'; tokenId: string }
  // Password management
  | { type: 'password.change'; currentPassword: string; newPassword: string }
  // Session management
  | { type: 'session.create'; profileId?: string; name?: string; cols?: number; rows?: number }
  | { type: 'session.attach'; sessionId: string; cols?: number; rows?: number; scrollbackLines?: number }
  | { type: 'session.detach' }
  | { type: 'session.input'; data: string }
  | { type: 'session.resize'; cols: number; rows: number }
  | { type: 'session.kill'; sessionId: string }
  | { type: 'session.rename'; sessionId: string; name: string }
  | { type: 'sessions.list' }
  // Window management (tmux windows within a session)
  | { type: 'window.select'; windowIndex: number }
  | { type: 'window.create'; name?: string }
  | { type: 'window.kill'; windowIndex: number }
  | { type: 'window.rename'; windowIndex: number; name: string }
  // Quick actions
  | { type: 'action.run'; profileId: string; actionId: string }
  // Profile management
  | { type: 'profiles.list' }
  | { type: 'profile.save'; profile: Profile }
  | { type: 'profile.delete'; profileId: string }
  | { type: 'profile.reorder'; profileIds: string[] }
  | { type: 'profile.discover' }
  // Health
  | { type: 'health.status' }
  // Scrollback
  | { type: 'session.scrollback'; lines?: number }
  // Keepalive
  | { type: 'ping' };

// ============================================================================
// Protocol Version
// ============================================================================

export const PROTOCOL_VERSION = 1;

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type ServerMessage =
  // Auth
  | { type: 'auth.ok'; serverName: string; setupMode: boolean; token?: string; protocolVersion?: number }
  | { type: 'auth.failed'; message: string; retryAfterMs?: number; permanentLock?: boolean }
  | { type: 'auth.required'; setupMode: boolean; protocolVersion?: number }
  // Token management
  | { type: 'token.list'; tokens: TokenInfo[] }
  | { type: 'token.created'; token: string; tokenId: string; name: string; expiresAt: string | null }
  | { type: 'token.revoked'; tokenId: string }
  // Password management
  | { type: 'password.changed'; token?: string }
  // Session events
  | { type: 'session.attached'; session: SessionInfo; scrollback?: string }
  | { type: 'session.output'; data: string; sessionId: string }
  | { type: 'session.ended'; sessionId: string }
  | { type: 'session.detached' }
  | { type: 'sessions.list'; sessions: SessionInfo[] }
  // Window events
  | { type: 'windows.list'; windows: TmuxWindowInfo[] }
  // Quick actions
  | { type: 'action.result'; actionId: string; output: string; exitCode: number }
  // Profile events
  | { type: 'profiles.list'; profiles: Profile[] }
  | { type: 'profiles.discovered'; profiles: Profile[] }
  // Health
  | { type: 'health.status'; statuses: HealthStatus[] }
  // Scrollback
  | { type: 'session.scrollback'; data: string }
  // General
  | { type: 'pong' }
  | { type: 'error'; message: string };
