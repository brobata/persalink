/**
 * @file HealthChecker
 * @description Periodically runs health check commands defined in profiles
 *   and maintains a status map. Clients can query health status to show
 *   green/red indicators on profile cards.
 */

import type { Profile, HealthStatus } from '@persalink/shared/protocol';
import { TmuxManager } from './tmuxManager';

export class HealthChecker {
  private statuses: Map<string, HealthStatus> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(private tmuxManager: TmuxManager) {}

  /** Start health checks for all profiles that have them configured */
  start(profiles: Profile[]): void {
    this.stopAll();

    for (const profile of profiles) {
      if (!profile.healthCheck) continue;

      const interval = Math.max(30, profile.healthCheck.intervalSeconds) * 1000;

      // Run immediately
      this.runCheck(profile);

      // Then on interval
      const timer = setInterval(() => this.runCheck(profile), interval);
      this.timers.set(profile.id, timer);
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  getStatuses(): HealthStatus[] {
    return Array.from(this.statuses.values());
  }

  getStatus(profileId: string): HealthStatus | undefined {
    return this.statuses.get(profileId);
  }

  private async runCheck(profile: Profile): Promise<void> {
    if (!profile.healthCheck) return;

    const { output, exitCode } = await this.tmuxManager.runHealthCheck(
      profile.healthCheck.command,
      profile.cwd,
    );

    let healthy: boolean;
    switch (profile.healthCheck.parser) {
      case 'exit-code':
        healthy = exitCode === 0;
        break;
      case 'json':
        try {
          const parsed = JSON.parse(output);
          healthy = parsed.healthy === true || parsed.status === 'ok' || parsed.status === 'healthy';
        } catch {
          healthy = false;
        }
        break;
      case 'contains':
        healthy = profile.healthCheck.contains
          ? output.includes(profile.healthCheck.contains)
          : exitCode === 0;
        break;
      default:
        healthy = exitCode === 0;
    }

    this.statuses.set(profile.id, {
      profileId: profile.id,
      healthy,
      lastCheck: Date.now(),
      output: output.slice(0, 1024),
    });
  }

  dispose(): void {
    this.stopAll();
  }
}
