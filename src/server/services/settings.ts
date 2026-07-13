import "server-only";

import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import {
  deleteSettingValue,
  getSettingUpdatedAt,
  getSettingValue,
  upsertSettingValue,
} from "@/src/server/repositories/settings";
import { base64Url, decryptJson, encryptJson, safeJsonParse } from "@/src/server/services/crypto";
import {
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
} from "@/src/shared/time";
import type {
  CredentialProxyConfig,
  CredentialProxyType,
  GlobalSettingsRecord,
  PublicCredentialProxyConfig,
  TimeZoneRebuildStatus,
} from "@/src/shared/types/entities";

const GLOBAL_PROXY_SETTING_KEY = "global_proxy";
const CODEX_USER_AGENT_SETTING_KEY = "codex_user_agent";
const FULL_REQUEST_LOGGING_SETTING_KEY = "full_request_logging";
const CODEX_AUTO_DISABLE_REFRESH_EXHAUSTED_SETTING_KEY =
  "codex_auto_disable_refresh_exhausted";
const REQUEST_LOG_RETENTION_DAYS_SETTING_KEY = "request_log_retention_days";
const REQUEST_LOG_DETAIL_RETENTION_DAYS_SETTING_KEY =
  "request_log_detail_retention_days";
const TIME_ZONE_SETTING_KEY = "time_zone";
const TIME_ZONE_PENDING_SETTING_KEY = "time_zone_pending";
const TIME_ZONE_REBUILD_STATUS_SETTING_KEY = "time_zone_rebuild_status";
const TIME_ZONE_REBUILD_ERROR_SETTING_KEY = "time_zone_rebuild_error";
const PUBLIC_BASE_URL_SETTING_KEY = "public_base_url";
const OIDC_CLIENT_ID_SETTING_KEY = "oidc_client_id";
const OIDC_CLIENT_SECRET_SETTING_KEY = "oidc_client_secret";
const OIDC_REDIRECT_URIS_SETTING_KEY = "oidc_redirect_uris";

const DEFAULT_REQUEST_LOG_RETENTION_DAYS = 90;
const DEFAULT_REQUEST_LOG_DETAIL_RETENTION_DAYS = 14;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const MAX_USER_AGENT_LENGTH = 2048;

export function getGlobalProxySetting(): CredentialProxyConfig | null {
  const stored = readStoredGlobalProxy();
  return stored || serverConfig.globalProxy;
}

export function getGlobalUserAgentSetting() {
  return readStoredUserAgent() || serverConfig.userAgent;
}

export function getEffectiveCodexUserAgent(input?: {
  userAgent?: string | null;
  tenantUserAgent?: string | null;
}) {
  return (
    normalizeStoredUserAgent(input?.userAgent) ||
    normalizeStoredUserAgent(input?.tenantUserAgent) ||
    getGlobalUserAgentSetting()
  );
}

export function getPublicGlobalSettings(): GlobalSettingsRecord {
  const stored = readStoredGlobalProxy();
  const storedUserAgent = readStoredUserAgent();
  const fullRequestLoggingEnabled = getFullRequestLoggingSetting();
  const codexAutoDisableRefreshExhausted =
    getCodexAutoDisableRefreshExhaustedSetting();
  const retentionSettings = getRequestLogRetentionSettings();
  const timeZoneSettings = getTimeZoneRebuildState();
  const updatedAt = latestUpdatedAt(
    getSettingUpdatedAt(PUBLIC_BASE_URL_SETTING_KEY),
    getSettingUpdatedAt(GLOBAL_PROXY_SETTING_KEY),
    getSettingUpdatedAt(CODEX_USER_AGENT_SETTING_KEY),
    getSettingUpdatedAt(FULL_REQUEST_LOGGING_SETTING_KEY),
    getSettingUpdatedAt(CODEX_AUTO_DISABLE_REFRESH_EXHAUSTED_SETTING_KEY),
    getSettingUpdatedAt(REQUEST_LOG_RETENTION_DAYS_SETTING_KEY),
    getSettingUpdatedAt(REQUEST_LOG_DETAIL_RETENTION_DAYS_SETTING_KEY),
    getSettingUpdatedAt(TIME_ZONE_SETTING_KEY),
    getSettingUpdatedAt(TIME_ZONE_PENDING_SETTING_KEY),
    getSettingUpdatedAt(TIME_ZONE_REBUILD_STATUS_SETTING_KEY),
    getSettingUpdatedAt(TIME_ZONE_REBUILD_ERROR_SETTING_KEY),
    getSettingUpdatedAt(OIDC_CLIENT_ID_SETTING_KEY),
    getSettingUpdatedAt(OIDC_CLIENT_SECRET_SETTING_KEY),
    getSettingUpdatedAt(OIDC_REDIRECT_URIS_SETTING_KEY),
  );
  const publicBaseUrl = getSettingValue(PUBLIC_BASE_URL_SETTING_KEY) || "";
  const oidc = getOidcProviderSettings();
  if (stored) {
    return {
      publicBaseUrl,
      ...publicOidcSettings(oidc),
      proxy: publicProxy(stored),
      proxySource: "database",
      userAgent: storedUserAgent || serverConfig.userAgent,
      userAgentSource: storedUserAgent
        ? "database"
        : serverConfig.userAgentSource,
      fullRequestLoggingEnabled,
      codexAutoDisableRefreshExhausted,
      ...retentionSettings,
      ...timeZoneSettings,
      updatedAt,
    };
  }
  if (serverConfig.globalProxy) {
    return {
      publicBaseUrl,
      ...publicOidcSettings(oidc),
      proxy: publicProxy(serverConfig.globalProxy),
      proxySource: "environment",
      userAgent: storedUserAgent || serverConfig.userAgent,
      userAgentSource: storedUserAgent
        ? "database"
        : serverConfig.userAgentSource,
      fullRequestLoggingEnabled,
      codexAutoDisableRefreshExhausted,
      ...retentionSettings,
      ...timeZoneSettings,
      updatedAt,
    };
  }
  return {
    publicBaseUrl,
    ...publicOidcSettings(oidc),
    proxy: null,
    proxySource: "none",
    userAgent: storedUserAgent || serverConfig.userAgent,
    userAgentSource: storedUserAgent
      ? "database"
      : serverConfig.userAgentSource,
    fullRequestLoggingEnabled,
    codexAutoDisableRefreshExhausted,
    ...retentionSettings,
    ...timeZoneSettings,
    updatedAt,
  };
}

export function patchGlobalSettings(input: {
  publicBaseUrl?: unknown;
  proxy?: unknown;
  userAgent?: unknown;
  fullRequestLoggingEnabled?: unknown;
  codexAutoDisableRefreshExhausted?: unknown;
  requestLogRetentionDays?: unknown;
  requestLogDetailRetentionDays?: unknown;
  timeZone?: unknown;
  oidcClientId?: unknown;
  oidcClientSecret?: unknown;
  oidcRedirectUris?: unknown;
}) {
  if (Object.hasOwn(input, "publicBaseUrl")) {
    const value = normalizePublicBaseUrl(input.publicBaseUrl);
    if (value) upsertSettingValue(PUBLIC_BASE_URL_SETTING_KEY, value);
    else deleteSettingValue(PUBLIC_BASE_URL_SETTING_KEY);
  }
  if (Object.hasOwn(input, "oidcClientId")) {
    const value = normalizeOidcClientId(input.oidcClientId);
    if (value) upsertSettingValue(OIDC_CLIENT_ID_SETTING_KEY, value);
    else deleteSettingValue(OIDC_CLIENT_ID_SETTING_KEY);
  }
  if (Object.hasOwn(input, "oidcClientSecret")) {
    const value = stringValue(input.oidcClientSecret);
    if (value.length < 24) throw new HttpError(400, "weak_oidc_client_secret", "OIDC client secret must be at least 24 characters");
    upsertSettingValue(OIDC_CLIENT_SECRET_SETTING_KEY, encryptJson({ value }));
  }
  if (Object.hasOwn(input, "oidcRedirectUris")) {
    upsertSettingValue(OIDC_REDIRECT_URIS_SETTING_KEY, JSON.stringify(normalizeOidcRedirectUris(input.oidcRedirectUris)));
  }
  if (Object.hasOwn(input, "proxy")) {
    const proxy = normalizeProxyInput(input.proxy, readStoredGlobalProxy());
    if (proxy) {
      upsertSettingValue(GLOBAL_PROXY_SETTING_KEY, encryptJson(proxy));
    } else {
      deleteSettingValue(GLOBAL_PROXY_SETTING_KEY);
    }
  }
  if (Object.hasOwn(input, "userAgent")) {
    const userAgent = normalizeCodexUserAgentInput(input.userAgent);
    if (userAgent) {
      upsertSettingValue(CODEX_USER_AGENT_SETTING_KEY, userAgent);
    } else {
      deleteSettingValue(CODEX_USER_AGENT_SETTING_KEY);
    }
  }
  if (Object.hasOwn(input, "fullRequestLoggingEnabled")) {
    upsertSettingValue(
      FULL_REQUEST_LOGGING_SETTING_KEY,
      input.fullRequestLoggingEnabled ? "1" : "0",
    );
  }
  if (Object.hasOwn(input, "codexAutoDisableRefreshExhausted")) {
    upsertSettingValue(
      CODEX_AUTO_DISABLE_REFRESH_EXHAUSTED_SETTING_KEY,
      input.codexAutoDisableRefreshExhausted ? "1" : "0",
    );
  }
  if (Object.hasOwn(input, "requestLogRetentionDays")) {
    upsertSettingValue(
      REQUEST_LOG_RETENTION_DAYS_SETTING_KEY,
      String(normalizeRetentionDays(input.requestLogRetentionDays)),
    );
  }
  if (Object.hasOwn(input, "requestLogDetailRetentionDays")) {
    upsertSettingValue(
      REQUEST_LOG_DETAIL_RETENTION_DAYS_SETTING_KEY,
      String(normalizeRetentionDays(input.requestLogDetailRetentionDays)),
    );
  }
  if (Object.hasOwn(input, "timeZone")) {
    requestGlobalTimeZoneChange(input.timeZone);
  }
  return getPublicGlobalSettings();
}

export function getOidcProviderSettings() {
  const issuer = getSettingValue(PUBLIC_BASE_URL_SETTING_KEY) || serverConfig.publicUrl;
  const clientId = getSettingValue(OIDC_CLIENT_ID_SETTING_KEY) || serverConfig.oidcClientId;
  const clientSecret = readOidcClientSecret() || serverConfig.oidcClientSecret;
  const storedRedirects = getSettingValue(OIDC_REDIRECT_URIS_SETTING_KEY);
  const redirectUris = storedRedirects
    ? safeJsonParse<string[]>(storedRedirects, [])
    : serverConfig.oidcRedirectUris;
  return { issuer, clientId, clientSecret, redirectUris };
}

export function rotateOidcClientSecret() {
  const clientSecret = base64Url(36);
  upsertSettingValue(OIDC_CLIENT_SECRET_SETTING_KEY, encryptJson({ value: clientSecret }));
  return { clientSecret, settings: getPublicGlobalSettings() };
}

function publicOidcSettings(settings: ReturnType<typeof getOidcProviderSettings>) {
  return {
    oidcClientId: settings.clientId,
    oidcClientSecretSet: Boolean(settings.clientSecret),
    oidcRedirectUris: settings.redirectUris,
    oidcIssuer: settings.issuer,
    oidcConfigured: Boolean(settings.issuer && settings.clientId && settings.clientSecret && settings.redirectUris.length),
  };
}

function readOidcClientSecret() {
  const value = getSettingValue(OIDC_CLIENT_SECRET_SETTING_KEY);
  if (!value) return "";
  try { return decryptJson<{ value?: string }>(value).value?.trim() || ""; }
  catch { return ""; }
}

function normalizeOidcClientId(input: unknown) {
  const value = stringValue(input);
  if (value.length > 128 || !/^[A-Za-z0-9._~-]*$/.test(value)) throw new HttpError(400, "invalid_oidc_client_id", "OIDC client ID contains unsupported characters");
  return value;
}

function normalizeOidcRedirectUris(input: unknown) {
  const values = Array.isArray(input) ? input : stringValue(input).split(/[\r\n,]+/);
  return [...new Set(values.map(stringValue).filter(Boolean).map((value) => {
    let url: URL; try { url = new URL(value); } catch { throw new HttpError(400, "invalid_oidc_redirect_uri", "OIDC redirect URI must be an absolute URL"); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new HttpError(400, "invalid_oidc_redirect_uri", "OIDC redirect URI must be an HTTP URL without credentials or fragment");
    return url.toString();
  }))];
}

export function normalizePublicBaseUrl(input: unknown) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return "";
  let url: URL;
  try { url = new URL(value); } catch {
    throw new HttpError(400, "invalid_public_base_url", "Public website URL must be an absolute HTTP URL");
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, "invalid_public_base_url", "Public website URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, "invalid_public_base_url", "Public website URL cannot contain credentials, query, or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function getGlobalTimeZoneSetting() {
  const value = getSettingValue(TIME_ZONE_SETTING_KEY);
  return isValidTimeZone(value) ? value : DEFAULT_TIME_ZONE;
}

export function getTimeZoneRebuildState() {
  const statusValue = getSettingValue(TIME_ZONE_REBUILD_STATUS_SETTING_KEY);
  const status: TimeZoneRebuildStatus = isTimeZoneRebuildStatus(statusValue)
    ? statusValue
    : "idle";
  const pendingValue = getSettingValue(TIME_ZONE_PENDING_SETTING_KEY);
  return {
    timeZone: getGlobalTimeZoneSetting(),
    timeZonePending: isValidTimeZone(pendingValue) ? pendingValue : null,
    timeZoneRebuildStatus: status,
    timeZoneRebuildError:
      getSettingValue(TIME_ZONE_REBUILD_ERROR_SETTING_KEY) || null,
  };
}

export function requestGlobalTimeZoneChange(input: unknown) {
  if (!isValidTimeZone(input)) {
    throw new HttpError(
      400,
      "invalid_time_zone",
      "Time zone must be a valid IANA timezone identifier",
    );
  }
  const timeZone = input.trim();
  if (timeZone === getGlobalTimeZoneSetting()) {
    deleteSettingValue(TIME_ZONE_PENDING_SETTING_KEY);
    upsertSettingValue(TIME_ZONE_REBUILD_STATUS_SETTING_KEY, "idle");
    deleteSettingValue(TIME_ZONE_REBUILD_ERROR_SETTING_KEY);
    return;
  }
  upsertSettingValue(TIME_ZONE_PENDING_SETTING_KEY, timeZone);
  upsertSettingValue(TIME_ZONE_REBUILD_STATUS_SETTING_KEY, "pending");
  deleteSettingValue(TIME_ZONE_REBUILD_ERROR_SETTING_KEY);
}

export function updateTimeZoneRebuildState(input: {
  status: TimeZoneRebuildStatus;
  error?: string | null;
  activate?: string;
}) {
  if (input.activate) {
    if (!isValidTimeZone(input.activate)) {
      throw new Error("Cannot activate an invalid IANA timezone");
    }
    upsertSettingValue(TIME_ZONE_SETTING_KEY, input.activate);
    deleteSettingValue(TIME_ZONE_PENDING_SETTING_KEY);
  }
  upsertSettingValue(TIME_ZONE_REBUILD_STATUS_SETTING_KEY, input.status);
  if (input.error) {
    upsertSettingValue(TIME_ZONE_REBUILD_ERROR_SETTING_KEY, input.error);
  } else {
    deleteSettingValue(TIME_ZONE_REBUILD_ERROR_SETTING_KEY);
  }
}

function isTimeZoneRebuildStatus(
  value: string | undefined,
): value is TimeZoneRebuildStatus {
  return (
    value === "idle" ||
    value === "pending" ||
    value === "running" ||
    value === "failed"
  );
}

export function getFullRequestLoggingSetting() {
  return getSettingValue(FULL_REQUEST_LOGGING_SETTING_KEY) === "1";
}

export function getCodexAutoDisableRefreshExhaustedSetting() {
  return (
    getSettingValue(CODEX_AUTO_DISABLE_REFRESH_EXHAUSTED_SETTING_KEY) === "1"
  );
}

export function getRequestLogRetentionSettings() {
  return {
    requestLogRetentionDays: readRetentionDays(
      REQUEST_LOG_RETENTION_DAYS_SETTING_KEY,
      DEFAULT_REQUEST_LOG_RETENTION_DAYS,
    ),
    requestLogDetailRetentionDays: readRetentionDays(
      REQUEST_LOG_DETAIL_RETENTION_DAYS_SETTING_KEY,
      DEFAULT_REQUEST_LOG_DETAIL_RETENTION_DAYS,
    ),
  };
}

function readRetentionDays(key: string, fallback: number) {
  const value = getSettingValue(key);
  if (value === undefined) {
    return fallback;
  }
  return normalizeRetentionDays(value);
}

function normalizeRetentionDays(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(
      400,
      "invalid_log_retention_days",
      "Log retention days must be a finite number",
    );
  }
  const days = Math.floor(parsed);
  if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new HttpError(
      400,
      "invalid_log_retention_days",
      `Log retention days must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
    );
  }
  return days;
}

function readStoredUserAgent() {
  return normalizeStoredUserAgent(
    getSettingValue(CODEX_USER_AGENT_SETTING_KEY),
  );
}

function normalizeStoredUserAgent(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  if (normalized.length > MAX_USER_AGENT_LENGTH) {
    return "";
  }
  return /[^\t\x20-\x7e]/.test(normalized) ? "" : normalized;
}

export function normalizeCodexUserAgentInput(input: unknown) {
  if (input === null || input === false) {
    return null;
  }
  if (typeof input !== "string") {
    throw new HttpError(
      400,
      "invalid_codex_user_agent",
      "Codex User-Agent must be a string or null",
    );
  }
  const value = input.trim();
  if (!value) {
    return null;
  }
  if (value.length > MAX_USER_AGENT_LENGTH) {
    throw new HttpError(
      400,
      "invalid_codex_user_agent",
      `Codex User-Agent must be ${MAX_USER_AGENT_LENGTH} characters or fewer`,
    );
  }
  if (/[^\t\x20-\x7e]/.test(value)) {
    throw new HttpError(
      400,
      "invalid_codex_user_agent",
      "Codex User-Agent must not contain control characters",
    );
  }
  return value;
}

function readStoredGlobalProxy() {
  const value = getSettingValue(GLOBAL_PROXY_SETTING_KEY);
  if (!value) {
    return null;
  }
  try {
    return decryptJson<CredentialProxyConfig>(value);
  } catch {
    return null;
  }
}

function normalizeProxyInput(
  input: unknown,
  existingProxy: CredentialProxyConfig | null,
): CredentialProxyConfig | null {
  if (input === null || input === false) {
    return null;
  }
  if (typeof input === "string") {
    return parseProxyUrl(input, existingProxy?.enabled ?? true);
  }
  const object = objectValue(input);
  if (!object) {
    throw new HttpError(
      400,
      "invalid_global_proxy",
      "Global proxy must be a SOCKS5 URL, object, or null",
    );
  }

  const url = stringValue(object.url);
  if (url) {
    const parsed = parseProxyUrl(url, existingProxy?.enabled ?? true);
    return {
      ...parsed,
      enabled:
        object.enabled !== undefined ? Boolean(object.enabled) : parsed.enabled,
    };
  }

  const type = normalizeProxyType(
    object.type,
    existingProxy?.type || "socks5h",
  );
  const host = stringValue(object.host) || existingProxy?.host || "";
  const port = normalizePort(object.port ?? existingProxy?.port);
  const username =
    object.username !== undefined
      ? stringValue(object.username)
      : existingProxy?.username || "";
  const password =
    object.password !== undefined
      ? stringValue(object.password)
      : existingProxy?.password || "";
  const enabled =
    object.enabled !== undefined
      ? Boolean(object.enabled)
      : (existingProxy?.enabled ?? true);

  assertProxyEndpoint({ host, port });
  return { enabled, type, host, port, username, password };
}

function parseProxyUrl(input: string, enabled: boolean): CredentialProxyConfig {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new HttpError(400, "invalid_global_proxy_url", "Invalid proxy URL");
  }
  const type = normalizeProxyType(parsed.protocol.replace(/:$/, ""), "socks5h");
  const host = parsed.hostname;
  const port = normalizePort(parsed.port);
  const username = decodeURIComponent(parsed.username || "");
  const password = decodeURIComponent(parsed.password || "");
  assertProxyEndpoint({ host, port });
  return { enabled, type, host, port, username, password };
}

function normalizeProxyType(
  value: unknown,
  fallback: CredentialProxyType,
): CredentialProxyType {
  const type = stringValue(value).toLowerCase();
  if (type === "socks5" || type === "socks5h") {
    return type;
  }
  if (!type) {
    return fallback;
  }
  throw new HttpError(
    400,
    "unsupported_global_proxy_type",
    "Only socks5 and socks5h global proxies are supported",
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
      "invalid_global_proxy_port",
      "Global proxy port must be between 1 and 65535",
    );
  }
  return port;
}

function assertProxyEndpoint(input: { host: string; port: number }) {
  if (!input.host.trim()) {
    throw new HttpError(
      400,
      "missing_global_proxy_host",
      "Global proxy host is required",
    );
  }
}

function publicProxy(
  proxy: CredentialProxyConfig,
): PublicCredentialProxyConfig {
  return {
    enabled: proxy.enabled,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    passwordSet: Boolean(proxy.password),
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function latestUpdatedAt(...values: Array<string | null>) {
  return values.filter(Boolean).sort().at(-1) || null;
}
