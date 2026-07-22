import { errorToResponse } from "@/src/server/http/errors";
import { getSubscriptionQuotaState } from "@/src/server/repositories/quotaAccounting";
import { listSubscriptions } from "@/src/server/services/tenantSubscriptions";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    return Response.json({
      tenantId: context.tenant.id,
      subscriptions: listSubscriptions(context.tenant.id, context.user.id).map((subscription) => ({
        id: subscription.id, name: subscription.name, units: subscription.units,
        unitsPerCredential: subscription.unitsPerCredential, enabled: subscription.enabled,
        startsAt: subscription.startsAt, expiresAt: subscription.expiresAt,
        windows: serialize(getSubscriptionQuotaState(subscription.id).windows),
      })),
    });
  } catch (error) { return errorToResponse(error); }
}
function serialize(windows: ReturnType<typeof getSubscriptionQuotaState>["windows"]) { return Object.fromEntries(Object.entries(windows).map(([kind, window]) => [kind, { ...window, limitNanoUsd: String(window.limitNanoUsd), settledNanoUsd: String(window.settledNanoUsd), reservedNanoUsd: String(window.reservedNanoUsd) }])); }
