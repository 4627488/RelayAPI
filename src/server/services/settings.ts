import "server-only";

import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import {
  deleteSettingValue,
  getSettingUpdatedAt,
  getSettingValue,
  upsertSettingValue,
} from "@/src/server/repositories/settings";
import { decryptJson, encryptJson } from "@/src/server/services/crypto";
import type {
  CredentialProxyConfig,
  CredentialProxyType,
  GlobalSettingsRecord,
  PublicCredentialProxyConfig,
} from "@/src/shared/types/entities";

const GLOBAL_PROXY_SETTING_KEY = "global_proxy";

export function getGlobalProxySetting(): CredentialProxyConfig | null {
  const stored = readStoredGlobalProxy();
  return stored || serverConfig.globalProxy;
}

export function getPublicGlobalSettings(): GlobalSettingsRecord {
  const stored = readStoredGlobalProxy();
  if (stored) {
    return {
      proxy: publicProxy(stored),
      proxySource: "database",
      updatedAt: getSettingUpdatedAt(GLOBAL_PROXY_SETTING_KEY),
    };
  }
  if (serverConfig.globalProxy) {
    return {
      proxy: publicProxy(serverConfig.globalProxy),
      proxySource: "environment",
      updatedAt: null,
    };
  }
  return { proxy: null, proxySource: "none", updatedAt: null };
}

export function patchGlobalSettings(input: { proxy?: unknown }) {
  if (Object.hasOwn(input, "proxy")) {
    const proxy = normalizeProxyInput(input.proxy, readStoredGlobalProxy());
    if (proxy) {
      upsertSettingValue(GLOBAL_PROXY_SETTING_KEY, encryptJson(proxy));
    } else {
      deleteSettingValue(GLOBAL_PROXY_SETTING_KEY);
    }
  }
  return getPublicGlobalSettings();
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

function publicProxy(proxy: CredentialProxyConfig): PublicCredentialProxyConfig {
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
