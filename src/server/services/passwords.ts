import "server-only";

import crypto from "node:crypto";

import { base64Url } from "@/src/server/services/crypto";

export function hashPassword(password: string) {
  const salt = base64Url(16);
  const key = crypto.scryptSync(password, salt, 64, {
    N: 16_384,
    r: 8,
    p: 1,
  });
  return `scrypt$16384$8$1$${salt}$${key.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, rawN, rawR, rawP, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) {
    return false;
  }
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  const actual = crypto.scryptSync(password, salt, 64, { N: n, r, p });
  const expectedBuffer = Buffer.from(expected, "base64url");
  return (
    actual.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actual, expectedBuffer)
  );
}
