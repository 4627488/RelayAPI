import { errorToResponse } from "@/src/server/http/errors";
import { getCodexResetCredits } from "@/src/server/services/codexQuota";
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
