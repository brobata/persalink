/**
 * @file Structured Security Audit Logging
 * @description Logs auth and system events in structured JSON. Never logs passwords or tokens.
 */

export type AuditEvent =
  | 'auth_success'
  | 'auth_failed'
  | 'token_auth_success'
  | 'token_auth_failed'
  | 'token_expired'
  | 'token_created'
  | 'token_revoked'
  | 'password_set'
  | 'password_changed'
  | 'rate_limited'
  | 'ws_connected'
  | 'ws_disconnected'
  | 'auth_timeout'
  | 'watchdog'
  | 'tmux_session_created'
  | 'tmux_session_killed'
  | 'tmux_session_renamed'
  | 'tmux_session_attached'
  | 'tmux_session_detached'
  | 'action_executed'
  | 'profiles_discovered';

interface AuditFields {
  ip?: string;
  token_name?: string;
  token_id?: string;
  tokenName?: string;
  tokenId?: string;
  name?: string;
  reason?: string;
  clientId?: string;
  retry_after_ms?: number;
  method?: string;
  sessionId?: string;
  profileId?: string;
  actionId?: string;
  count?: number;
  heap_mb?: number;
  rss_mb?: number;
  sessions?: number;
  clients?: number;
}

const WARN_EVENTS: Set<AuditEvent> = new Set([
  'auth_failed', 'token_auth_failed', 'token_expired', 'auth_timeout',
]);
const ERROR_EVENTS: Set<AuditEvent> = new Set(['rate_limited']);

function getLevel(event: AuditEvent): string {
  if (event === 'watchdog') return 'info';
  if (ERROR_EVENTS.has(event)) return 'error';
  if (WARN_EVENTS.has(event)) return 'warn';
  return 'info';
}

export function audit(event: AuditEvent, fields: AuditFields = {}): void {
  const level = getLevel(event);
  const entry: Record<string, unknown> = {
    level,
    component: event === 'watchdog' ? 'health' : event.startsWith('tmux') ? 'tmux' : 'auth',
    event,
    timestamp: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    entry[key] = value;
  }
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}
