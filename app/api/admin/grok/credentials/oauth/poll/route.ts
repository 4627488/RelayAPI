import { errorToResponse } from "@/src/server/http/errors";
import { finishGrokOAuth } from "@/src/server/services/grokCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request) { try { requireWebRequest(request); const body = await request.json() as { sessionId?: string }; const credential = await finishGrokOAuth(String(body.sessionId || "")); return credential ? Response.json(credential, { status: 201 }) : Response.json({ pending: true }, { status: 202 }); } catch (error) { return errorToResponse(error); } }
