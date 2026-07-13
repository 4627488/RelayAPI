import { errorToResponse } from "@/src/server/http/errors";
import { getCostAnalysis } from "@/src/server/repositories/logs";
import { getSubscriptionQuotaState } from "@/src/server/repositories/quotaAccounting";
import { getTenantSubscription } from "@/src/server/repositories/tenantSubscriptions";
import { attachConfiguredModelPrices } from "@/src/server/services/quotaAdministration";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    const context = requireTenantRequest(request);
    const subscriptionId = new URL(request.url).searchParams.get("subscriptionId") || "";
    const subscription = getTenantSubscription(subscriptionId);
    if (!subscription || subscription.tenantId !== context.tenant.id) {
      return Response.json({ error: { code: "subscription_not_found", message: "Subscription not found" } }, { status: 404 });
    }
    const weekly = getSubscriptionQuotaState(subscriptionId).windows["7d"];
    return Response.json(attachConfiguredModelPrices(getCostAnalysis({ tenantId: context.tenant.id, subscriptionId, ...(weekly ? { startedAt: weekly.startedAt, endedAt: weekly.resetsAt } : {}) })));
  } catch (error) {
    return errorToResponse(error);
  }
}
