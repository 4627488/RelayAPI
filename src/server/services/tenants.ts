import "server-only";

import crypto from "node:crypto";

import { getEncryptionSecret } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import { countApiKeysByTenant } from "@/src/server/repositories/apiKeys";
import { getTenantDailyUsage } from "@/src/server/repositories/quotaUsage";
import {
  getTenantById,
  getTenantInviteByTokenHash,
  getTenantPasswordResetByTokenHash,
  getLatestTenantInvite,
  getPendingTenantInvite,
  getTenantOwnerUser,
  getTenantUserByEmail,
  getTenantUserById,
  insertTenant,
  insertTenantInvite,
  insertTenantPasswordReset,
  insertTenantUser,
  listTenants,
  markTenantInviteAccepted,
  consumeTenantPasswordReset,
  publicProxy,
  updateTenant,
  updateTenantUser,
} from "@/src/server/repositories/tenants";
import { listChannelRecords } from "@/src/server/services/channels";
import { normalizeCodexUserAgentInput } from "@/src/server/services/settings";
import { base64Url, randomId, sha256 } from "@/src/server/services/crypto";
import {
  hashPassword,
  verifyPassword,
} from "@/src/server/services/passwords";
import type {
  CreatedTenantInvite,
  CredentialProxyConfig,
  CredentialProxyType,
  PublicTenant,
  TenantRecord,
  TenantResources,
  TenantUserRecord,
  TenantWithSecrets,
} from "@/src/shared/types/entities";

export const TENANT_SESSION_COOKIE = "relay_tenant_session";

const TENANT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TENANT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

type TenantSessionPayload = {
  v: 1;
  tenantId: string;
  userId: string;
  sessionVersion: number;
  iat: number;
  exp: number;
  nonce: string;
};

export type TenantSessionContext = {
  tenant: TenantWithSecrets;
  user: TenantUserRecord;
};

export type TenantPayload = {
  name?: unknown;
  ownerEmail?: unknown;
  enabled?: unknown;
  maxApiKeys?: unknown;
  tokenLimitDaily?: unknown;
  rateLimitPerMinute?: unknown;
  modelAllowlist?: unknown;
  channelAllowlist?: unknown;
  allowCustomProxy?: unknown;
  allowCustomUserAgent?: unknown;
  proxy?: unknown;
  userAgent?: unknown;
  expiresAt?: unknown;
};

export function listPublicTenants(): PublicTenant[] {
  return listTenants().map(toPublicTenant);
}

export function getPublicTenantById(id: string) {
  const tenant = getTenantById(id);
  return tenant ? toPublicTenant(tenant) : null;
}

export function createTenant(input: TenantPayload): PublicTenant {
  const name = cleanString(input.name);
  const ownerEmail = normalizeOptionalEmail(input.ownerEmail);
  if (!name) {
    throw new HttpError(400, "invalid_tenant_name", "Tenant name is required");
  }
  if (ownerEmail && getTenantUserByEmail(ownerEmail)) {
    throw new HttpError(
      409,
      "tenant_owner_exists",
      "A tenant user with this email already exists",
    );
  }

  const tenant = insertTenant({
    id: randomId("tenant"),
    name,
    ownerEmail,
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : true,
    maxApiKeys: normalizeNullablePositiveInteger(input.maxApiKeys),
    tokenLimitDaily: normalizeNullablePositiveInteger(input.tokenLimitDaily),
    rateLimitPerMinute: normalizeNullablePositiveInteger(
      input.rateLimitPerMinute,
    ),
    modelAllowlist: cleanStringArray(input.modelAllowlist),
    channelAllowlist: cleanStringArray(input.channelAllowlist),
    allowCustomProxy: Boolean(input.allowCustomProxy),
    allowCustomUserAgent: Boolean(input.allowCustomUserAgent),
    proxy: normalizeTenantProxyInput(input.proxy, null),
    userAgent: normalizeCodexUserAgentInput(input.userAgent ?? null),
    expiresAt: cleanString(input.expiresAt) || null,
  });
  if (!tenant) {
    throw new Error("Failed to create tenant");
  }
  if (ownerEmail) {
    insertTenantUser({
      id: randomId("tuser"),
      tenantId: tenant.id,
      email: ownerEmail,
      displayName: name,
    });
  }
  return toPublicTenant(tenant);
}

export function patchTenant(id: string, input: TenantPayload): PublicTenant {
  const existing = requireTenantById(id);
  const ownerEmail =
    input.ownerEmail !== undefined
      ? normalizeOptionalEmail(input.ownerEmail)
      : existing.ownerEmail;
  const next = updateTenant(id, {
    ...(input.name !== undefined ? { name: cleanString(input.name) } : {}),
    ownerEmail,
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.maxApiKeys !== undefined
      ? { maxApiKeys: normalizeNullablePositiveInteger(input.maxApiKeys) }
      : {}),
    ...(input.tokenLimitDaily !== undefined
      ? {
          tokenLimitDaily: normalizeNullablePositiveInteger(
            input.tokenLimitDaily,
          ),
        }
      : {}),
    ...(input.rateLimitPerMinute !== undefined
      ? {
          rateLimitPerMinute: normalizeNullablePositiveInteger(
            input.rateLimitPerMinute,
          ),
        }
      : {}),
    ...(input.modelAllowlist !== undefined
      ? { modelAllowlist: cleanStringArray(input.modelAllowlist) }
      : {}),
    ...(input.channelAllowlist !== undefined
      ? { channelAllowlist: cleanStringArray(input.channelAllowlist) }
      : {}),
    ...(input.allowCustomProxy !== undefined
      ? { allowCustomProxy: Boolean(input.allowCustomProxy) }
      : {}),
    ...(input.allowCustomUserAgent !== undefined
      ? { allowCustomUserAgent: Boolean(input.allowCustomUserAgent) }
      : {}),
    ...(input.proxy !== undefined
      ? { proxy: normalizeTenantProxyInput(input.proxy, existing.proxy) }
      : {}),
    ...(input.userAgent !== undefined
      ? { userAgent: normalizeCodexUserAgentInput(input.userAgent) }
      : {}),
    ...(input.expiresAt !== undefined
      ? { expiresAt: cleanString(input.expiresAt) || null }
      : {}),
  });
  if (!next) {
    throw new HttpError(404, "tenant_not_found", "Tenant not found");
  }
  return toPublicTenant(next);
}

export function removeTenant(id: string) {
  const existing = requireTenantById(id);
  updateTenant(existing.id, {
    enabled: false,
    deletedAt: new Date().toISOString(),
  });
}

export function createTenantInvite(input: {
  tenantId: string;
  requestUrl: string;
}): CreatedTenantInvite {
  const tenant = requireTenantById(input.tenantId);
  if (tenant.ownerEmail || getTenantOwnerUser(tenant.id)) {
    throw new HttpError(
      409,
      "tenant_user_exists",
      "Tenant already has a registered user",
    );
  }
  if (getLatestTenantInvite(tenant.id)) {
    throw new HttpError(
      409,
      "tenant_invite_exists",
      "Tenant already has an invitation",
    );
  }
  const token = `relay_invite_${base64Url(32)}`;
  const expiresAt = new Date(Date.now() + TENANT_INVITE_TTL_MS).toISOString();
  const invite = insertTenantInvite({
    id: randomId("tinvite"),
    tenantId: tenant.id,
    tokenHash: sha256(token),
    expiresAt,
  });
  if (!invite) {
    throw new Error("Failed to create tenant invite");
  }
  return {
    id: invite.id,
    tenantId: tenant.id,
    email: invite.email,
    expiresAt,
    token,
    activateUrl: tenantActivateUrl(input.requestUrl, token),
  };
}

export function activateTenantInvite(input: {
  token: unknown;
  email: unknown;
  password: unknown;
  displayName?: unknown;
}): TenantSessionContext {
  const token = cleanString(input.token);
  const email = normalizeEmail(input.email);
  const displayName = cleanString(input.displayName);
  const password = cleanString(input.password);
  if (!displayName) {
    throw new HttpError(
      400,
      "invalid_tenant_display_name",
      "Display name is required",
    );
  }
  if (!email) {
    throw new HttpError(
      400,
      "invalid_tenant_email",
      "Valid email is required",
    );
  }
  assertPassword(password);
  const invite = token ? getTenantInviteByTokenHash(sha256(token)) : null;
  if (!invite) {
    throw new HttpError(404, "tenant_invite_not_found", "Invite not found");
  }
  if (invite.revokedAt) {
    throw new HttpError(403, "tenant_invite_revoked", "Invite was revoked");
  }
  if (invite.acceptedAt) {
    throw new HttpError(403, "tenant_invite_used", "Invite was already used");
  }
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    throw new HttpError(403, "tenant_invite_expired", "Invite has expired");
  }
  const tenant = requireUsableTenant(invite.tenantId);
  const existingUser = getTenantUserByEmail(email);
  if (existingUser && existingUser.tenantId !== tenant.id) {
    throw new HttpError(
      409,
      "tenant_email_exists",
      "A tenant user with this email already exists",
    );
  }
  if (existingUser && existingUser.passwordHash) {
    throw new HttpError(
      409,
      "tenant_email_exists",
      "A tenant user with this email already exists",
    );
  }
  const user =
    existingUser ||
    insertTenantUser({
      id: randomId("tuser"),
      tenantId: tenant.id,
      email,
      displayName,
      passwordHash: null,
    });
  if (!user || user.tenantId !== tenant.id || !user.enabled) {
    throw new HttpError(403, "tenant_user_disabled", "Tenant user is disabled");
  }
  const updated = updateTenantUser(user.id, {
    displayName,
    passwordHash: hashPassword(password),
    lastLoginAt: new Date().toISOString(),
  });
  updateTenant(tenant.id, { ownerEmail: email });
  markTenantInviteAccepted(invite.id, { userId: user.id, email });
  if (!updated) {
    throw new Error("Failed to activate tenant user");
  }
  return { tenant, user: updated };
}

export function loginTenant(input: {
  email: unknown;
  password: unknown;
}): TenantSessionContext {
  const email = normalizeEmail(input.email);
  const password = cleanString(input.password);
  const user = email ? getTenantUserByEmail(email) : null;
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw new HttpError(
      401,
      "invalid_tenant_credentials",
      "Tenant email or password is incorrect",
    );
  }
  if (!user.enabled) {
    throw new HttpError(403, "tenant_user_disabled", "Tenant user is disabled");
  }
  const tenant = requireUsableTenant(user.tenantId);
  const updated = updateTenantUser(user.id, {
    lastLoginAt: new Date().toISOString(),
  });
  return { tenant, user: updated || user };
}

export function createTenantSessionToken(
  context: Pick<TenantSessionContext, "tenant" | "user">,
  now = Date.now(),
) {
  const issuedAt = Math.floor(now / 1000);
  const payload = encodeBase64UrlJson({
    v: 1,
    tenantId: context.tenant.id,
    userId: context.user.id,
    sessionVersion: context.user.sessionVersion,
    iat: issuedAt,
    exp: issuedAt + TENANT_SESSION_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString("base64url"),
  } satisfies TenantSessionPayload);
  return `${payload}.${signSessionPayload(payload)}`;
}

export function getTenantSessionFromCookieValue(
  value: string | null | undefined,
): TenantSessionContext | null {
  const payload = decodeTenantSessionPayload(value);
  if (!payload) {
    return null;
  }
  const tenant = getTenantById(payload.tenantId);
  const user = getTenantUserById(payload.userId);
  if (
    !tenant ||
    !user ||
    user.tenantId !== tenant.id ||
    !tenant.enabled ||
    !user.enabled ||
    payload.sessionVersion !== user.sessionVersion ||
    (tenant.expiresAt && Date.parse(tenant.expiresAt) <= Date.now())
  ) {
    return null;
  }
  return { tenant, user };
}

export function createTenantPasswordReset(tenantId: string) {
  const tenant = requireTenantById(tenantId);
  const user = getTenantOwnerUser(tenant.id);
  if (!user) {
    throw new HttpError(409, "tenant_user_missing", "Tenant has no registered owner");
  }
  const token = `relay_reset_${base64Url(32)}`;
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
  insertTenantPasswordReset({
    id: randomId("treset"), tenantId: tenant.id, userId: user.id,
    tokenHash: sha256(token), expiresAt,
  });
  return { token, resetPath: `/tenant/reset-password?token=${encodeURIComponent(token)}`, expiresAt };
}

export function completeTenantPasswordReset(tokenInput: unknown, passwordInput: unknown): TenantSessionContext {
  const token = cleanString(tokenInput);
  const password = cleanString(passwordInput);
  assertPassword(password);
  const reset = token ? getTenantPasswordResetByTokenHash(sha256(token)) : null;
  if (!reset || reset.consumedAt || reset.revokedAt || Date.parse(reset.expiresAt) <= Date.now()) {
    throw new HttpError(400, "invalid_password_reset", "Password reset link is invalid or expired");
  }
  const tenant = requireUsableTenant(reset.tenantId);
  const user = getTenantUserById(reset.userId);
  if (!user || user.tenantId !== tenant.id || !user.enabled) {
    throw new HttpError(400, "invalid_password_reset", "Password reset link is invalid or expired");
  }
  const updated = updateTenantUser(user.id, {
    passwordHash: hashPassword(password),
    passwordChangedAt: new Date().toISOString(),
    sessionVersion: user.sessionVersion + 1,
  });
  consumeTenantPasswordReset(reset.id);
  if (!updated) throw new Error("Failed to reset tenant password");
  return { tenant, user: updated };
}

export function changeTenantPassword(context: TenantSessionContext, currentInput: unknown, nextInput: unknown) {
  const current = cleanString(currentInput);
  const next = cleanString(nextInput);
  assertPassword(next);
  if (!context.user.passwordHash || !verifyPassword(current, context.user.passwordHash)) {
    throw new HttpError(401, "invalid_current_password", "Current password is incorrect");
  }
  if (verifyPassword(next, context.user.passwordHash)) {
    throw new HttpError(400, "password_unchanged", "New password must be different");
  }
  const updated = updateTenantUser(context.user.id, {
    passwordHash: hashPassword(next), passwordChangedAt: new Date().toISOString(),
    sessionVersion: context.user.sessionVersion + 1,
  });
  if (!updated) throw new Error("Failed to change tenant password");
  return { tenant: context.tenant, user: updated };
}

export function revokeTenantSessions(tenantId: string) {
  const tenant = requireTenantById(tenantId);
  const user = getTenantOwnerUser(tenant.id);
  if (!user) throw new HttpError(409, "tenant_user_missing", "Tenant has no registered owner");
  return updateTenantUser(user.id, { sessionVersion: user.sessionVersion + 1 });
}

export function requireTenantRequest(request: Request): TenantSessionContext {
  const context = getTenantSessionFromCookieValue(
    readCookie(request.headers.get("cookie"), TENANT_SESSION_COOKIE),
  );
  if (!context) {
    throw new HttpError(
      401,
      "tenant_auth_required",
      "Tenant login is required",
    );
  }
  if (isUnsafeMethod(request.method) && !isSameOriginRequest(request)) {
    throw new HttpError(
      403,
      "csrf_origin_mismatch",
      "Request origin is not allowed",
    );
  }
  return context;
}

export async function getTenantResources(
  tenant: TenantWithSecrets,
): Promise<TenantResources> {
  const allowedChannelIds = new Set(tenant.channelAllowlist);
  const channels = listChannelRecords()
    .filter((channel) =>
      allowedChannelIds.size > 0 ? allowedChannelIds.has(channel.id) : true,
    )
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      enabled: channel.enabled,
      status: channel.status,
      modelAllowlist: channel.modelAllowlist,
    }));
  const channelModels = [
    ...new Set(channels.flatMap((channel) => channel.modelAllowlist)),
  ];
  return {
    models: tenant.modelAllowlist.length > 0 ? tenant.modelAllowlist : channelModels,
    channels,
  };
}


export function patchTenantSettings(
  context: TenantSessionContext,
  input: { proxy?: unknown; userAgent?: unknown },
): TenantRecord {
  const patch: TenantPayload = {};
  if (Object.hasOwn(input, "proxy")) {
    if (!context.tenant.allowCustomProxy) {
      throw new HttpError(
        403,
        "tenant_proxy_not_allowed",
        "Tenant proxy settings are not enabled by the administrator",
      );
    }
    patch.proxy = input.proxy;
  }
  if (Object.hasOwn(input, "userAgent")) {
    if (!context.tenant.allowCustomUserAgent) {
      throw new HttpError(
        403,
        "tenant_user_agent_not_allowed",
        "Tenant User-Agent settings are not enabled by the administrator",
      );
    }
    patch.userAgent = input.userAgent;
  }
  return patchTenant(context.tenant.id, patch);
}

export function tenantSessionCookieOptions(request: Request | string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
    path: "/",
    maxAge: TENANT_SESSION_TTL_SECONDS,
  };
}

export function expiredTenantSessionCookieOptions(request: Request | string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  };
}

export function toPublicTenant(tenant: TenantWithSecrets): PublicTenant {
  const counts = countApiKeysByTenant(tenant.id);
  const pendingInvite = getPendingTenantInvite(tenant.id);
  return {
    ...tenant,
    proxy: publicProxy(tenant.proxy),
    apiKeyCount: counts.total,
    enabledApiKeyCount: counts.enabled,
    todayTokens: getTenantDailyUsage(tenant.id),
    pendingInvite: Boolean(pendingInvite),
    lastLoginAt: getTenantOwnerUser(tenant.id)?.lastLoginAt || null,
    passwordChangedAt: getTenantOwnerUser(tenant.id)?.passwordChangedAt || null,
  };
}

function requireTenantById(id: string) {
  const tenant = getTenantById(id);
  if (!tenant) {
    throw new HttpError(404, "tenant_not_found", "Tenant not found");
  }
  return tenant;
}

function requireUsableTenant(id: string) {
  const tenant = requireTenantById(id);
  if (!tenant.enabled) {
    throw new HttpError(403, "tenant_disabled", "Tenant is disabled");
  }
  if (tenant.expiresAt && Date.parse(tenant.expiresAt) <= Date.now()) {
    throw new HttpError(403, "tenant_expired", "Tenant is expired");
  }
  return tenant;
}

function tenantActivateUrl(requestUrl: string, token: string) {
  const url = new URL(requestUrl);
  url.pathname = "/tenant/activate";
  url.search = "";
  url.searchParams.set("token", token);
  return url.toString();
}

function decodeTenantSessionPayload(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) {
    return null;
  }
  if (!timingSafeAsciiEqual(signature, signSessionPayload(payload))) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<TenantSessionPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (
      parsed.v === 1 &&
      typeof parsed.tenantId === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.sessionVersion === "number" &&
      typeof parsed.iat === "number" &&
      typeof parsed.exp === "number" &&
      typeof parsed.nonce === "string" &&
      parsed.iat <= now + 60 &&
      parsed.exp > now
    ) {
      return parsed as TenantSessionPayload;
    }
  } catch {
    return null;
  }
  return null;
}

function signSessionPayload(payload: string) {
  return crypto
    .createHmac("sha256", getEncryptionSecret())
    .update(payload, "utf8")
    .digest("base64url");
}

function encodeBase64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function assertPassword(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(
      400,
      "weak_tenant_password",
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
}

function normalizeTenantProxyInput(
  input: unknown,
  existingProxy: CredentialProxyConfig | null,
): CredentialProxyConfig | null {
  if (input === undefined) {
    return existingProxy;
  }
  if (input === null || input === false || input === "") {
    return null;
  }
  if (typeof input === "string") {
    return parseProxyUrl(input, existingProxy?.enabled ?? true);
  }
  const object = objectValue(input);
  if (!object) {
    throw new HttpError(
      400,
      "invalid_tenant_proxy",
      "Tenant proxy must be a SOCKS5 URL, object, or null",
    );
  }
  const url = cleanString(object.url);
  if (url) {
    const parsed = parseProxyUrl(url, existingProxy?.enabled ?? true);
    return {
      ...parsed,
      enabled:
        object.enabled !== undefined ? Boolean(object.enabled) : parsed.enabled,
    };
  }
  const type = normalizeProxyType(object.type, existingProxy?.type || "socks5h");
  const host = cleanString(object.host) || existingProxy?.host || "";
  const port = normalizePort(object.port ?? existingProxy?.port);
  const username =
    object.username !== undefined
      ? cleanString(object.username)
      : existingProxy?.username || "";
  const password =
    object.password !== undefined
      ? cleanString(object.password)
      : existingProxy?.password || "";
  const enabled =
    object.enabled !== undefined
      ? Boolean(object.enabled)
      : (existingProxy?.enabled ?? true);
  if (!host) {
    throw new HttpError(
      400,
      "missing_tenant_proxy_host",
      "Tenant proxy host is required",
    );
  }
  return { enabled, type, host, port, username, password };
}

function parseProxyUrl(input: string, enabled: boolean): CredentialProxyConfig {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new HttpError(400, "invalid_tenant_proxy_url", "Invalid proxy URL");
  }
  const type = normalizeProxyType(parsed.protocol.replace(/:$/, ""), "socks5h");
  const port = normalizePort(parsed.port);
  if (!parsed.hostname) {
    throw new HttpError(
      400,
      "missing_tenant_proxy_host",
      "Tenant proxy host is required",
    );
  }
  return {
    enabled,
    type,
    host: parsed.hostname,
    port,
    username: decodeURIComponent(parsed.username || ""),
    password: decodeURIComponent(parsed.password || ""),
  };
}

function normalizeProxyType(
  value: unknown,
  fallback: CredentialProxyType,
): CredentialProxyType {
  const type = cleanString(value).toLowerCase();
  if (type === "socks5" || type === "socks5h") {
    return type;
  }
  if (!type) {
    return fallback;
  }
  throw new HttpError(
    400,
    "unsupported_tenant_proxy_type",
    "Only socks5 and socks5h tenant proxies are supported",
  );
}

function normalizePort(value: unknown) {
  const port =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(
      400,
      "invalid_tenant_proxy_port",
      "Tenant proxy port must be between 1 and 65535",
    );
  }
  return port;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown) {
  const email = cleanString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizeOptionalEmail(value: unknown) {
  const raw = cleanString(value);
  if (!raw) {
    return "";
  }
  const email = normalizeEmail(raw);
  if (!email) {
    throw new HttpError(
      400,
      "invalid_tenant_owner_email",
      "Valid owner email is required",
    );
  }
  return email;
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function normalizeNullablePositiveInteger(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? Math.floor(numberValue)
    : null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return null;
  }
  for (const item of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (rawName === name) {
      const value = rawValue.join("=");
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

function timingSafeAsciiEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isSameOriginRequest(request: Request) {
  const requestOrigin = originFromRequest(request);
  if (!requestOrigin) {
    return false;
  }
  const origin = request.headers.get("origin");
  if (origin) {
    return originFromUrl(origin) === requestOrigin;
  }
  const referer = request.headers.get("referer");
  if (referer) {
    return originFromUrl(referer) === requestOrigin;
  }
  return true;
}

function originFromRequest(request: Request) {
  const urlOrigin = originFromUrl(request.url);
  const requestUrl = parseUrl(request.url);
  if (!requestUrl) {
    return urlOrigin;
  }
  const host =
    firstHeaderValue(request.headers.get("x-forwarded-host")) ||
    request.headers.get("host") ||
    requestUrl.host;
  if (!host) {
    return urlOrigin;
  }
  const proto =
    firstHeaderValue(request.headers.get("x-forwarded-proto")) ||
    requestUrl.protocol.replace(/:$/, "") ||
    "http";
  return originFromUrl(`${proto}://${host}`);
}

function isUnsafeMethod(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function originFromUrl(input: string) {
  try {
    return new URL(input).origin;
  } catch {
    return "";
  }
}

function parseUrl(input: string) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

function isSecureRequest(input: Request | string) {
  if (process.env.RELAY_SECURE_COOKIES === "1") {
    return true;
  }
  if (typeof input === "string") {
    return isHttpsUrl(input);
  }
  const forwardedProto = firstHeaderValue(
    input.headers.get("x-forwarded-proto"),
  ).toLowerCase();
  if (forwardedProto) {
    return forwardedProto === "https";
  }
  return isHttpsUrl(input.url);
}

function isHttpsUrl(input: string) {
  try {
    return new URL(input).protocol === "https:";
  } catch {
    return false;
  }
}
