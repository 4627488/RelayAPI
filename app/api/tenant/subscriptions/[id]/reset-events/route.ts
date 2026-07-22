import { errorToResponse, HttpError } from "@/src/server/http/errors";
import { listCredentialQuotaResetEvents } from "@/src/server/repositories/credentialQuotaResetEvents";
import { getTenantSubscription } from "@/src/server/repositories/tenantSubscriptions";
import { requireTenantRequest } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/tenant/subscriptions/[id]/reset-events">) {
  try {
    const auth = requireTenantRequest(request);
    const { id } = await context.params;
    const subscription = getTenantSubscription(id);
    if (!subscription || subscription.tenantId !== auth.tenant.id || subscription.tenantUserId !== auth.user.id) {
      throw new HttpError(404, "subscription_not_found", "Subscription not found");
    }
    return Response.json({
      subscription: { id: subscription.id, name: subscription.name },
      events: listCredentialQuotaResetEvents(subscription.credentialId)
        .filter((event) => event.occurredAt >= subscription.startsAt && (!subscription.expiresAt || event.occurredAt <= subscription.expiresAt))
        .map((event) => ({
        id: event.id,
        windowKind: event.windowKind,
        source: event.source,
        previousResetsAt: event.previousResetsAt,
        nextResetsAt: event.nextResetsAt,
        previousUsedPercent: event.previousUsedPercent,
        windowsReset: event.windowsReset,
        occurredAt: event.occurredAt,
        })),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
