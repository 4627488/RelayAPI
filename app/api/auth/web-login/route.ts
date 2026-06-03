import { cookies } from "next/headers";

import { errorToResponse, HttpError } from "@/src/server/http/errors";
import {
  createWebSessionToken,
  verifyAdminCredentials,
  WEB_SESSION_COOKIE,
  webSessionCookieOptions,
} from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const input = objectValue(body);
    if (
      !verifyAdminCredentials({
        username: input?.username,
        password: input?.password,
      })
    ) {
      throw new HttpError(
        401,
        "invalid_admin_credentials",
        "管理员账号或密码不正确",
      );
    }

    const cookieStore = await cookies();
    cookieStore.set(
      WEB_SESSION_COOKIE,
      createWebSessionToken(),
      webSessionCookieOptions(request),
    );

    return Response.json({ authenticated: true });
  } catch (error) {
    return errorToResponse(error);
  }
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
