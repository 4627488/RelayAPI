import { errorToResponse } from "@/src/server/http/errors";
import { patchSubscription, removeSubscription } from "@/src/server/services/tenantSubscriptions";
import { requireWebRequest } from "@/src/server/services/webAccess";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { try { requireWebRequest(request); const { id } = await context.params; return Response.json(patchSubscription(id, await request.json())); } catch (error) { return errorToResponse(error); } }
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { try { requireWebRequest(request); const { id } = await context.params; removeSubscription(id); return Response.json({ id, deleted: true }); } catch (error) { return errorToResponse(error); } }
