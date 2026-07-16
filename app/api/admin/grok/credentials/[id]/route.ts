import { errorToResponse } from "@/src/server/http/errors";
import { patchGrokCredential, removeGrokCredential } from "@/src/server/services/grokCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function PATCH(request: Request, context: RouteContext<"/api/admin/grok/credentials/[id]">) { try { requireWebRequest(request); const { id } = await context.params; return Response.json(patchGrokCredential(id, await request.json() as Record<string, unknown>)); } catch (error) { return errorToResponse(error); } }
export async function DELETE(request: Request, context: RouteContext<"/api/admin/grok/credentials/[id]">) { try { requireWebRequest(request); const { id } = await context.params; removeGrokCredential(id); return new Response(null, { status: 204 }); } catch (error) { return errorToResponse(error); } }
