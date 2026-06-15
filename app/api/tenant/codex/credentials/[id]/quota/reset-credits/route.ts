import { errorToResponse } from "@/src/server/http/errors";
import {
  consumeCodexResetCredit,
  getCodexResetCredits,
} from "@/src/server/services/codexQuota";
import {
  assertTenantCredentialAccess,
  requireTenantRequest,
} from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    const session = requireTenantRequest(request);
    ({ id } = await context.params);
    await assertTenantCredentialAccess(session.tenant, id);

    const searchParams = new URL(request.url).searchParams;
    return Response.json(
      await getCodexResetCredits({
        credentialId: id,
        includeRaw: searchParams.get("raw") === "1",
      }),
    );
  } catch (error) {
    return errorToResponse(error, {
      operation: "tenant.codex.reset_credits.query",
      request,
      metadata: id ? { credentialId: id } : undefined,
    });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    const session = requireTenantRequest(request);
    ({ id } = await context.params);
    await assertTenantCredentialAccess(session.tenant, id);

    const searchParams = new URL(request.url).searchParams;
    const body = await request.json().catch(() => ({}));
    const payload = body && typeof body === "object" ? body : {};
    return Response.json(
      await consumeCodexResetCredit({
        credentialId: id,
        creditId: stringValue(payload, "creditId") || stringValue(payload, "credit_id"),
        redeemRequestId:
          stringValue(payload, "redeemRequestId") ||
          stringValue(payload, "redeem_request_id"),
        includeRaw: searchParams.get("raw") === "1",
      }),
    );
  } catch (error) {
    return errorToResponse(error, {
      operation: "tenant.codex.reset_credits.consume",
      request,
      metadata: id ? { credentialId: id } : undefined,
    });
  }
}

function stringValue(source: object, key: string) {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}
