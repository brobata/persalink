/**
 * @file Cloudflare Access JWT verification
 * @description The public door only serves requests that carry a valid
 *   `Cf-Access-Jwt-Assertion` from our Access application. Checked at the
 *   origin even though Cloudflare already enforced it, so a loosened Access
 *   policy (or traffic that reaches the port some other way) still can't get
 *   in. RS256 against the team's published JWKS; aud, iss, exp and the email
 *   allowlist must all match.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AccessJwtConfig {
  /** e.g. "brobata.cloudflareaccess.com" */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access app */
  aud: string;
  /** Lower-case emails allowed through (must mirror the Access policy) */
  allowedEmails: string[];
}

export interface AccessIdentity {
  email: string;
  /** Access session expiry, epoch ms. */
  expiresAt: number;
}

/** Either the verified identity or why it was refused (for the audit log). */
export type AccessResult = { identity: AccessIdentity } | { reason: string };

export type AccessVerifier = (jwt: string | undefined) => Promise<AccessResult>;

/**
 * Build a verifier. `keySet` is injectable for tests; production fetches
 * https://<team>/cdn-cgi/access/certs (jose caches it and refetches on an
 * unknown `kid`, which covers Cloudflare's key rotation).
 */
export function createAccessVerifier(cfg: AccessJwtConfig, keySet?: JWTVerifyGetKey): AccessVerifier {
  const issuer = `https://${cfg.teamDomain}`;
  // PERSALINK_ACCESS_JWKS_URL exists for the integration test's local key
  // server; anyone able to set this process's env already has the shell.
  const certsUrl = process.env.PERSALINK_ACCESS_JWKS_URL || `${issuer}/cdn-cgi/access/certs`;
  const jwks = keySet ?? createRemoteJWKSet(new URL(certsUrl), {
    cacheMaxAge: 60 * 60 * 1000,
  });
  const allowed = new Set(cfg.allowedEmails.map((e) => e.trim().toLowerCase()));

  return async (jwt) => {
    if (!jwt) return { reason: 'missing' };
    try {
      const { payload } = await jwtVerify(jwt, jwks, {
        issuer,
        audience: cfg.aud,
        algorithms: ['RS256'],
        clockTolerance: 30,
      });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
      if (!email || !allowed.has(email)) return { reason: 'email_not_allowed' };
      const expiresAt = typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now();
      return { identity: { email, expiresAt } };
    } catch (err) {
      return { reason: (err as { code?: string }).code || 'invalid' };
    }
  };
}
