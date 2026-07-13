import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";

import { serverConfig } from "@/src/server/config/env";
import { getMainOrm } from "@/src/server/db/sqlite";
import { oidcAuthorizationCodes } from "@/src/server/db/schema";
import { getTenantById, getTenantUserById } from "@/src/server/repositories/tenants";
import { base64Url, sha256 } from "@/src/server/services/crypto";
import { HttpError } from "@/src/server/http/errors";
import { getOidcProviderSettings } from "@/src/server/services/settings";

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

type TokenClaims = {
  iss: string; sub: string; aud: string; exp: number; iat: number;
  typ: "access" | "refresh" | "id"; scope: string; nonce?: string;
};

export function oidcDiscovery() {
  const issuer = getOidcProviderSettings().issuer;
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/oidc/authorize`,
    token_endpoint: `${issuer}/api/oidc/token`,
    userinfo_endpoint: `${issuer}/api/oidc/userinfo`,
    jwks_uri: `${issuer}/api/oidc/jwks`,
    end_session_endpoint: `${issuer}/api/oidc/logout`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email"],
    claims_supported: ["sub", "email", "email_verified", "name", "preferred_username", "tenant_id", "role"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  };
}

export function validateAuthorizationRequest(url: URL) {
  assertConfigured();
  const settings = getOidcProviderSettings();
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const responseType = url.searchParams.get("response_type") || "";
  const scope = normalizeScope(url.searchParams.get("scope"));
  if (clientId !== settings.clientId || !validRedirectUri(redirectUri, settings.redirectUris)) throw oauthError("invalid_request", "Invalid OIDC client or redirect URI");
  if (responseType !== "code" || !scope.split(" ").includes("openid")) throw oauthError("unsupported_response_type", "Only OpenID authorization code flow is supported");
  const method = url.searchParams.get("code_challenge_method");
  const challenge = url.searchParams.get("code_challenge");
  if ((method || challenge) && (method !== "S256" || !challenge)) throw oauthError("invalid_request", "Only PKCE S256 is supported");
  return { clientId, redirectUri, scope, state: url.searchParams.get("state"), nonce: url.searchParams.get("nonce"), codeChallenge: challenge };
}

export function createAuthorizationRedirect(input: ReturnType<typeof validateAuthorizationRequest>, userId: string) {
  const code = base64Url(32);
  const now = new Date();
  getMainOrm().insert(oidcAuthorizationCodes).values({
    codeHash: sha256(code), clientId: input.clientId, userId,
    redirectUri: input.redirectUri, scope: input.scope, nonce: input.nonce,
    codeChallenge: input.codeChallenge,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    consumedAt: null, createdAt: now.toISOString(),
  }).run();
  const target = new URL(input.redirectUri);
  target.searchParams.set("code", code);
  if (input.state) target.searchParams.set("state", input.state);
  return target.toString();
}

export function exchangeAuthorizationCode(input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier?: string | null }) {
  authenticateClient(input.clientId, input.clientSecret);
  const orm = getMainOrm();
  return orm.transaction((tx) => {
    const row = tx.select().from(oidcAuthorizationCodes).where(and(eq(oidcAuthorizationCodes.codeHash, sha256(input.code)), isNull(oidcAuthorizationCodes.consumedAt))).get();
    if (!row || row.expiresAt <= new Date().toISOString() || row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) throw oauthError("invalid_grant", "Authorization code is invalid or expired");
    if (row.codeChallenge && pkceChallenge(input.codeVerifier || "") !== row.codeChallenge) throw oauthError("invalid_grant", "PKCE verification failed");
    tx.update(oidcAuthorizationCodes).set({ consumedAt: new Date().toISOString() }).where(eq(oidcAuthorizationCodes.codeHash, row.codeHash)).run();
    return issueTokens(row.userId, row.clientId, row.scope, row.nonce || undefined);
  });
}

export function exchangeRefreshToken(input: { refreshToken: string; clientId: string; clientSecret: string }) {
  authenticateClient(input.clientId, input.clientSecret);
  const claims = verifyToken(input.refreshToken, "refresh");
  if (claims.aud !== input.clientId) throw oauthError("invalid_grant", "Refresh token audience is invalid");
  return issueTokens(claims.sub, claims.aud, claims.scope);
}

export function oidcUserInfo(token: string) {
  const claims = verifyToken(token, "access");
  return userClaims(claims.sub);
}

export function oidcJwks() {
  const { publicKey, kid } = signingKeys();
  return { keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] };
}

export function oauthBearer(request: Request) {
  const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "invalid_token", "Missing bearer access token");
  return match[1].trim();
}

function issueTokens(userId: string, audience: string, scope: string, nonce?: string) {
  const profile = userClaims(userId);
  const idClaims = {
    email: profile.email,
    email_verified: profile.email_verified,
    name: profile.name,
    preferred_username: profile.preferred_username,
    tenant_id: profile.tenant_id,
    role: profile.role,
  };
  const accessToken = signToken({ sub: userId, aud: audience, typ: "access", scope }, ACCESS_TTL_SECONDS);
  const idToken = signToken({ sub: userId, aud: audience, typ: "id", scope, nonce, ...idClaims }, ACCESS_TTL_SECONDS);
  const refreshToken = signToken({ sub: userId, aud: audience, typ: "refresh", scope }, REFRESH_TTL_SECONDS);
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, id_token: idToken, scope };
}

function userClaims(userId: string) {
  const user = getTenantUserById(userId);
  const tenant = user ? getTenantById(user.tenantId) : null;
  if (!user || !user.enabled || !tenant || !tenant.enabled || (tenant.expiresAt && tenant.expiresAt <= new Date().toISOString())) throw oauthError("invalid_grant", "User is not available");
  return { sub: user.id, email: user.email, email_verified: true, name: user.displayName || user.email, preferred_username: user.email, tenant_id: tenant.id, role: user.role };
}

function signToken(input: Record<string, unknown> & { sub: string; aud: string; typ: TokenClaims["typ"]; scope: string }, ttl: number) {
  const now = Math.floor(Date.now() / 1000);
  const { privateKey, kid } = signingKeys();
  const issuer = getOidcProviderSettings().issuer;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: issuer, iat: now, exp: now + ttl, ...input })).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token: string, type: TokenClaims["typ"]) {
  const parts = token.split(".");
  if (parts.length !== 3) throw oauthError("invalid_token", "Token is invalid");
  const { publicKey } = signingKeys();
  if (!crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"))) throw oauthError("invalid_token", "Token signature is invalid");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenClaims;
  if (claims.iss !== getOidcProviderSettings().issuer || claims.typ !== type || claims.exp <= Math.floor(Date.now() / 1000)) throw oauthError("invalid_token", "Token is invalid or expired");
  return claims;
}

function signingKeys() {
  const file = path.join(serverConfig.dataDir, ".relay-oidc-rsa.json");
  fs.mkdirSync(serverConfig.dataDir, { recursive: true });
  if (!fs.existsSync(file)) {
    const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.writeFileSync(file, JSON.stringify({ privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }), publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), { mode: 0o600 });
  }
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { privateKey: string; publicKey: string };
  const privateKey = crypto.createPrivateKey(stored.privateKey);
  const publicKey = crypto.createPublicKey(stored.publicKey);
  const kid = sha256(String(stored.publicKey)).slice(0, 16);
  return { privateKey, publicKey, kid };
}

function authenticateClient(id: string, secret: string) {
  assertConfigured();
  const settings = getOidcProviderSettings();
  const a = Buffer.from(secret); const b = Buffer.from(settings.clientSecret);
  if (id !== settings.clientId || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw oauthError("invalid_client", "OIDC client authentication failed");
}

function assertConfigured() {
  const settings = getOidcProviderSettings();
  if (!settings.issuer || !settings.clientSecret || !settings.redirectUris.length) throw new HttpError(503, "oidc_not_configured", "OIDC provider is not configured");
}
function validRedirectUri(value: string, allowed: string[]) { return allowed.includes(value); }
function normalizeScope(value: string | null) { return [...new Set((value || "openid profile email").split(/\s+/).filter(Boolean))].join(" "); }
function pkceChallenge(value: string) { return crypto.createHash("sha256").update(value).digest("base64url"); }
function oauthError(code: string, message: string) { return new HttpError(code === "invalid_client" ? 401 : 400, code, message); }
