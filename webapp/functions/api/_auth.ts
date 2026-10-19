// Cloudflare Access JWT verifier (Pages Functions / Workers runtime).
//
// Cloudflare Access injects `Cf-Access-Jwt-Assertion` on every request that
// reaches the protected origin. We verify the JWT against CF Access's JWKS so
// that a leaked function URL can't be hit directly from outside the gate.
//
// Required env vars (set on the Pages project):
//   CF_ACCESS_TEAM_DOMAIN   e.g. "yourteam.cloudflareaccess.com"
//   CF_ACCESS_AUD           the application AUD tag (from the Access app)
//   ALLOWED_EMAIL           the single allowlisted user
//
// Local dev / wrangler dev: when CF_ACCESS_TEAM_DOMAIN is empty, the verifier
// short-circuits to "OK" so `wrangler pages dev` runs without a real CF Access
// session in front of it.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface Env {
  DATA_BUCKET: R2Bucket;
  DEEPSEEK_API_KEY: string;
  VOYAGE_API_KEY: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ALLOWED_EMAIL?: string;
  // Opt-in escape hatch for `wrangler pages dev` (no CF Access in front). When
  // CF_ACCESS_TEAM_DOMAIN is unset we fail CLOSED unless this is 'true', so a
  // forgotten env var in production can never silently disable the gate.
  ALLOW_UNAUTHENTICATED_DEV?: string;
  // D1 binding for cross-device sync + rate limiting (optional).
  DB?: D1Database;
}

// Lazily-initialised JWKS fetcher; cached across warm invocations.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks(teamDomain: string) {
  if (_jwks) return _jwks;
  _jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  return _jwks;
}

export interface AuthResult {
  ok: boolean;
  email?: string;
  // Cloudflare Access's stable internal user id (JWT `sub`). Preferred over
  // email as a sync partition key - it survives an email change.
  sub?: string;
  reason?: string;
  // HTTP status the caller should return on failure. 401 for a bad/absent
  // token; 500 when the SERVER is misconfigured (so the failure is loud, not a
  // silently-weaker gate).
  status?: number;
  payload?: JWTPayload;
}

export async function verifyAccess(request: Request, env: Env): Promise<AuthResult> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN ?? '';
  if (!teamDomain) {
    // No CF Access in front. Fail CLOSED unless explicitly opted into for local
    // `wrangler pages dev` - never silently allow everyone in production.
    if (env.ALLOW_UNAUTHENTICATED_DEV === 'true') {
      return { ok: true, email: 'local@dev', sub: 'local', reason: 'cf-access-disabled-dev' };
    }
    return { ok: false, status: 500, reason: 'server_misconfigured: CF_ACCESS_TEAM_DOMAIN unset' };
  }
  // AUD is the ONLY per-app discriminator (issuer + JWKS are tenant-wide), so a
  // missing AUD would silently accept tokens minted for any app in the tenant.
  // Require it explicitly rather than passing `undefined` (= no aud check).
  if (!env.CF_ACCESS_AUD) {
    return { ok: false, status: 500, reason: 'server_misconfigured: CF_ACCESS_AUD unset' };
  }
  const headerToken = request.headers.get('Cf-Access-Jwt-Assertion');
  const cookieToken = (() => {
    const cookie = request.headers.get('Cookie') ?? '';
    const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  })();
  const token = headerToken || cookieToken;
  if (!token) return { ok: false, status: 401, reason: 'missing_jwt' };
  try {
    const { payload } = await jwtVerify(token, jwks(teamDomain), {
      audience: env.CF_ACCESS_AUD,
      issuer: `https://${teamDomain}`,
      algorithms: ['RS256'], // CF Access signs with RS256; pin it to kill alg-confusion
    });
    const email = String(payload.email ?? '').toLowerCase();
    const sub = payload.sub ? String(payload.sub) : undefined;
    // Service-token JWTs (used by deploy verification via verify_cloud_data.py)
    // carry `common_name` (the service token Client ID) instead of `email` and
    // have an empty `sub`. They are authorized by the Access Service Auth policy
    // at the edge - the signature + AUD + issuer + RS256 checks above already
    // validated the JWT, so the human-email allowlist does not apply. Use
    // common_name as the identity for rate-limiting / sync partitioning.
    const commonName = String(payload.common_name ?? '');
    if (commonName) {
      return { ok: true, email: '', sub: commonName, payload };
    }
    const allowed = (env.ALLOWED_EMAIL ?? '').toLowerCase();
    // Fail CLOSED: with no allowlisted email configured, no human is admitted.
    if (!allowed) {
      return { ok: false, status: 500, reason: 'server_misconfigured: ALLOWED_EMAIL unset' };
    }
    if (email !== allowed) {
      return { ok: false, status: 401, reason: 'email_not_allowed', email };
    }
    return { ok: true, email, sub, payload };
  } catch (e) {
    return { ok: false, status: 401, reason: `jwt_invalid: ${(e as Error).message}` };
  }
}

/** Build the failure Response for an unsuccessful AuthResult (401 or 500). */
export function denyResponse(auth: AuthResult): Response {
  const status = auth.status ?? 401;
  return new Response(
    JSON.stringify({ error: status === 500 ? 'server_misconfigured' : 'unauthorized', reason: auth.reason }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Short-circuit handler. Returns null when OK, else a 401/500 Response. */
export async function requireAccess(request: Request, env: Env): Promise<Response | null> {
  const auth = await verifyAccess(request, env);
  return auth.ok ? null : denyResponse(auth);
}
