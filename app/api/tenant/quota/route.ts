import { errorToResponse } from "@/src/server/http/errors";
import { getTenantQuotaState } from "@/src/server/repositories/quotaAccounting";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    const state = getTenantQuotaState(context.tenant.id);
    return Response.json({
      tenantId: context.tenant.id,
      shares: context.tenant.quotaShares,
      windows: Object.fromEntries(
        Object.entries(state.windows).map(([kind, window]) => [kind, {
          ...window,
          limitNanoUsd: String(window.limitNanoUsd),
          settledNanoUsd: String(window.settledNanoUsd),
          reservedNanoUsd: String(window.reservedNanoUsd),
        }]),
      ),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
