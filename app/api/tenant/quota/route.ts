import { errorToResponse } from "@/src/server/http/errors";
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
        windows: subscription.quota,
      })),
    });
  } catch (error) { return errorToResponse(error); }
}
