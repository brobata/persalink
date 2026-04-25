/**
 * @file PersaLink Protocol v1
 * @description Shared schemas + types for tmux session orchestrator communication.
 *   Uses zod schemas as the single source of truth — the TS types below are
 *   derived from them via z.infer, and the schemas double as runtime
 *   validators at the WebSocket boundary and inside ProfileManager.
 */

import { z } from 'zod';

// ============================================================================
// Profiles
// ============================================================================

const PROFILE_ID_RX = /^[a-z0-9_-]+$/;
const COLOR_HEX_RX = /^#[0-9a-fA-F]{6}$/;
const ENV_KEY_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const NoLeadingDash = (s: string) => !s.startsWith('-');
const NoControlChars = (s: string) => !/[\x00-\x1f]/.test(s);
const NoNewlines = (s: string) => !/[\r\n]/.test(s);

export const QuickActionSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  command: z.string().min(1).max(1024).refine(NoNewlines, 'Command cannot contain newlines'),
  icon: z.string().max(8).optional(),
  confirm: z.boolean().optional(),
});

export const HealthCheckSchema = z.object({
  command: z.string().min(1).max(1024).refine(NoNewlines, 'Command cannot contain newlines'),
  intervalSeconds: z.number().int().positive().max(86400),
  parser: z.enum(['exit-code', 'json', 'contains']),
  contains: z.string().max(256).optional(),
});

export const ProfileSchema = z.object({
  id: z.string().regex(PROFILE_ID_RX, 'Profile ID must be alphanumeric with hyphens/underscores').max(100),
  name: z.string().min(1).max(100),
  icon: z.string().max(8).optional(),
  color: z.string().regex(COLOR_HEX_RX, 'Color must be a hex color (e.g. #ff5500)').optional().nullable(),
  cwd: z.string().max(512)
    .refine(NoLeadingDash, 'Working directory cannot start with "-"')
    .refine(NoControlChars, 'Working directory contains control characters')
    .optional(),
  command: z.string().max(2048).refine(NoNewlines, 'Command cannot contain newlines').optional(),
  shell: z.string().max(256)
    .refine((s) => !/[;&|`$]/.test(s), 'Shell path contains invalid characters')
    .refine(NoLeadingDash, 'Shell path cannot start with "-"')
    .optional(),
  env: z.record(
    z.string().regex(ENV_KEY_RX, 'Invalid env key').max(64),
    z.string().max(2048).refine(NoControlChars, 'Env value contains control characters'),
  ).refine((r) => Object.keys(r).length <= 32, 'Max 32 environment variables').optional(),
  group: z.string().max(50).optional(),
  pinned: z.boolean().optional(),
  actions: z.array(QuickActionSchema).max(10).optional(),
  healthCheck: HealthCheckSchema.optional(),
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(2).max(200).optional(),
});

export type QuickAction = z.infer<typeof QuickActionSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

// ============================================================================
// Tmux Sessions
// ============================================================================

export const TmuxWindowInfoSchema = z.object({
  index: z.number().int().min(0),
  name: z.string(),
  active: z.boolean(),
  paneCount: z.number().int().min(1),
});

export const SessionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  profileId: z.string().optional(),
  profileName: z.string().optional(),
  profileColor: z.string().optional(),
  profileIcon: z.string().optional(),
  windows: z.array(TmuxWindowInfoSchema),
  createdAt: z.number(),
  attached: z.boolean(),
  idleSeconds: z.number().optional(),
});

export const HealthStatusSchema = z.object({
  profileId: z.string(),
  healthy: z.boolean(),
  lastCheck: z.number(),
  output: z.string().optional(),
});

export type TmuxWindowInfo = z.infer<typeof TmuxWindowInfoSchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

// ============================================================================
// Token Info
// ============================================================================

export const TokenInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string().nullable(),
});

export type TokenInfo = z.infer<typeof TokenInfoSchema>;

// ============================================================================
// Client -> Server Messages
// ============================================================================

const ColsField = z.number().int().min(10).max(500).optional();
const RowsField = z.number().int().min(2).max(200).optional();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  // Auth
  z.object({ type: z.literal('auth'), password: z.string().min(1).max(256), tokenName: z.string().max(100).optional() }),
  z.object({ type: z.literal('auth.token'), token: z.string().min(1).max(512) }),
  // Token management
  z.object({ type: z.literal('token.list') }),
  z.object({ type: z.literal('token.create'), name: z.string().max(100), ttlDays: z.number().int().nullable().optional() }),
  z.object({ type: z.literal('token.revoke'), tokenId: z.string().max(128) }),
  // Password management
  z.object({ type: z.literal('password.change'), currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }),
  // Session management
  z.object({ type: z.literal('session.create'), profileId: z.string().max(100).optional(), name: z.string().max(100).optional(), cols: ColsField, rows: RowsField }),
  z.object({ type: z.literal('session.attach'), sessionId: z.string().max(256), cols: ColsField, rows: RowsField, scrollbackLines: z.number().int().min(0).max(10000).optional() }),
  z.object({ type: z.literal('session.detach') }),
  z.object({ type: z.literal('session.input'), data: z.string().max(1_000_000) }),
  z.object({ type: z.literal('session.resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(2).max(200) }),
  z.object({ type: z.literal('session.kill'), sessionId: z.string().max(256) }),
  z.object({ type: z.literal('session.rename'), sessionId: z.string().max(256), name: z.string().max(100) }),
  z.object({ type: z.literal('sessions.list') }),
  // Window management
  z.object({ type: z.literal('window.select'), windowIndex: z.number().int().min(0) }),
  z.object({ type: z.literal('window.create'), name: z.string().max(100).optional() }),
  z.object({ type: z.literal('window.kill'), windowIndex: z.number().int().min(0) }),
  z.object({ type: z.literal('window.rename'), windowIndex: z.number().int().min(0), name: z.string().max(100) }),
  // Quick actions
  z.object({ type: z.literal('action.run'), profileId: z.string().max(100), actionId: z.string().max(100) }),
  // Profile management
  z.object({ type: z.literal('profiles.list') }),
  z.object({ type: z.literal('profile.save'), profile: ProfileSchema }),
  z.object({ type: z.literal('profile.delete'), profileId: z.string().max(100) }),
  z.object({ type: z.literal('profile.reorder'), profileIds: z.array(z.string().max(100)).max(1000) }),
  z.object({ type: z.literal('profile.discover') }),
  // Health
  z.object({ type: z.literal('health.status') }),
  // Scrollback
  z.object({ type: z.literal('session.scrollback'), lines: z.number().int().optional() }),
  // Keepalive
  z.object({ type: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ============================================================================
// Protocol Version
// ============================================================================

export const PROTOCOL_VERSION = 1;

// ============================================================================
// Server -> Client Messages
// ============================================================================

// Server messages aren't validated at runtime on either side (the server
// produces them, the client consumes them), so these stay as plain TS unions
// for ergonomics. If we ever want full bidirectional validation we can
// promote to schemas the same way.
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
  | { type: 'action.result'; actionId: string; profileId: string; output: string; exitCode: number; timedOut?: boolean; truncated?: boolean; spawnError?: boolean }
  // Profile events
  | { type: 'profiles.list'; profiles: Profile[] }
  | { type: 'profiles.discovered'; profiles: Profile[] }
  // Health
  | { type: 'health.status'; statuses: HealthStatus[] }
  // Scrollback
  | { type: 'session.scrollback'; data: string }
  // General
  | { type: 'pong' }
  | { type: 'error'; message: string; op?: string };

// ============================================================================
// Boundary parsing helpers
// ============================================================================

/** Parse an inbound client message. Throws zod errors with structured paths. */
export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessageSchema.parse(raw);
}

/** Validate a profile shape. Returns null on success, error message on failure. */
export function validateProfileShape(profile: unknown): string | null {
  const result = ProfileSchema.safeParse(profile);
  if (result.success) return null;
  const first = result.error.issues[0];
  return first ? `${first.path.join('.') || 'profile'}: ${first.message}` : 'Invalid profile';
}
