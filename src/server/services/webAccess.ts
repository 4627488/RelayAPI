import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import { base64Url } from "@/src/server/services/crypto";
import {
  hashPassword,
  verifyPassword,
} from "@/src/server/services/passwords";

export const WEB_SESSION_COOKIE = "relay_web_session";

const ADMIN_USERNAME = "admin";
const ADMIN_ACCOUNT_FILE = ".relay-admin-account";
const WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const ADMIN_PASSWORD_ENV_NAMES = ["RELAY_ADMIN_PASSWORD", "ADMIN_PASSWORD"];

type StoredAdminAccount = {
  v: 1;
  username: "admin";
  passwordHash: string;
  createdAt: string;
};

type AdminAccountRecord = {
  username: "admin";
  passwordHash: string;
  source: "env" | "file";
};

type WebSessionPayload = {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
};

let cachedAdminAccount: AdminAccountRecord | null = null;

export function initializeWebAccessKey() {
  getAdminAccountRecord();
}

export function verifyAdminCredentials(input: {
  username: unknown;
  password: unknown;
}) {
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (username !== ADMIN_USERNAME || !password) {
    return false;
  }
  return verifyPassword(password, getAdminAccountRecord().passwordHash);
}

export function createWebSessionToken(now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = encodeBase64UrlJson({
    v: 1,
    iat: issuedAt,
    exp: issuedAt + WEB_SESSION_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString("base64url"),
  } satisfies WebSessionPayload);
  return `${payload}.${signSessionPayload(payload)}`;
}

export function isValidWebSessionValue(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) {
    return false;
  }
  if (!timingSafeAsciiEqual(signature, signSessionPayload(payload))) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<WebSessionPayload>;
    const now = Math.floor(Date.now() / 1000);
    return (
      parsed.v === 1 &&
      typeof parsed.iat === "number" &&
      typeof parsed.exp === "number" &&
      typeof parsed.nonce === "string" &&
      parsed.iat <= now + 60 &&
      parsed.exp > now
    );
  } catch {
    return false;
  }
}

export function isWebRequestAuthenticated(request: Request) {
  return isValidWebSessionValue(
    readCookie(request.headers.get("cookie"), WEB_SESSION_COOKIE),
  );
}

export function requireWebRequest(request: Request) {
  if (!isWebRequestAuthenticated(request)) {
    throw new HttpError(401, "web_auth_required", "Web access key is required");
  }
  if (isUnsafeMethod(request.method) && !isSameOriginRequest(request)) {
    throw new HttpError(
      403,
      "csrf_origin_mismatch",
      "Request origin is not allowed",
    );
  }
}

export function requireWebMutationRequest(request: Request) {
  requireWebRequest(request);
  if (!isSameOriginRequest(request)) {
    throw new HttpError(
      403,
      "csrf_origin_mismatch",
      "Request origin is not allowed",
    );
  }
}

export function webSessionCookieOptions(request: Request | string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
    path: "/",
    maxAge: WEB_SESSION_TTL_SECONDS,
  };
}

export function expiredWebSessionCookieOptions(request: Request | string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  };
}

function getAdminAccountRecord(): AdminAccountRecord {
  if (cachedAdminAccount) {
    return cachedAdminAccount;
  }

  const configuredPassword = configuredAdminPassword();
  if (configuredPassword) {
    cachedAdminAccount = {
      username: ADMIN_USERNAME,
      passwordHash: hashPassword(configuredPassword),
      source: "env",
    };
    return cachedAdminAccount;
  }

  const accountPath = path.join(serverConfig.dataDir, ADMIN_ACCOUNT_FILE);
  const existing = readStoredAdminAccount(accountPath);
  if (existing) {
    cachedAdminAccount = {
      username: ADMIN_USERNAME,
      passwordHash: existing.passwordHash,
      source: "file",
    };
    return cachedAdminAccount;
  }

  const generatedPassword = generateAdminPassword();
  const stored: StoredAdminAccount = {
    v: 1,
    username: ADMIN_USERNAME,
    passwordHash: hashPassword(generatedPassword),
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(accountPath), { recursive: true });
  try {
    fs.writeFileSync(accountPath, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    cachedAdminAccount = {
      username: ADMIN_USERNAME,
      passwordHash: stored.passwordHash,
      source: "file",
    };
    logGeneratedAdminAccount(generatedPassword, accountPath);
    return cachedAdminAccount;
  } catch (error) {
    if (isFileAlreadyExistsError(error)) {
      const racedExisting = readStoredAdminAccount(accountPath);
      if (racedExisting) {
        cachedAdminAccount = {
          username: ADMIN_USERNAME,
          passwordHash: racedExisting.passwordHash,
          source: "file",
        };
        return cachedAdminAccount;
      }
    }
    throw error;
  }
}

function configuredAdminPassword() {
  for (const name of ADMIN_PASSWORD_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function readStoredAdminAccount(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<StoredAdminAccount>;
    if (
      parsed.v === 1 &&
      parsed.username === ADMIN_USERNAME &&
      typeof parsed.passwordHash === "string" &&
      parsed.passwordHash.startsWith("scrypt$")
    ) {
      return parsed as StoredAdminAccount;
    }
  } catch {
    regenerateStoredAdminAccount(filePath);
    return readStoredAdminAccount(filePath);
  }
  regenerateStoredAdminAccount(filePath);
  return readStoredAdminAccount(filePath);
}

function regenerateStoredAdminAccount(filePath: string) {
  const generatedPassword = generateAdminPassword();
  const stored: StoredAdminAccount = {
    v: 1,
    username: ADMIN_USERNAME,
    passwordHash: hashPassword(generatedPassword),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
  });
  logGeneratedAdminAccount(generatedPassword, filePath);
}

function generateAdminPassword() {
  return `RelayAPI-${base64Url(24)}`;
}

function logGeneratedAdminAccount(password: string, filePath: string) {
  console.info("");
  console.info("============================================================");
  console.info("RelayAPI 管理员账号已初始化（密码只显示这一次）:");
  console.info(`账号: ${ADMIN_USERNAME}`);
  console.info(`密码: ${password}`);
  console.info(`密码哈希已保存到: ${filePath}`);
  console.info("如果丢失，请删除上面的账号文件后重启服务重新生成。");
  console.info("============================================================");
  console.info("");
}

function signSessionPayload(payload: string) {
  return crypto
    .createHmac("sha256", getAdminAccountRecord().passwordHash)
    .update(payload, "utf8")
    .digest("base64url");
}

function encodeBase64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function timingSafeAsciiEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
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

  // Non-browser clients may omit both headers; SameSite cookies still protect
  // browsers, and direct API clients cannot forge a valid signed session cookie.
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

function isFileAlreadyExistsError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
