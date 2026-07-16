import { errorToResponse } from "@/src/server/http/errors";
import { startGrokOAuth } from "@/src/server/services/grokCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request) { try { requireWebRequest(request); return Response.json(await startGrokOAuth()); } catch (error) { return errorToResponse(error); } }
