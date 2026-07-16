import { errorToResponse } from "@/src/server/http/errors";
import { importGrokApiKey, listPublicGrokCredentials } from "@/src/server/services/grokCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { requireWebRequest(request); return Response.json(listPublicGrokCredentials()); } catch (error) { return errorToResponse(error); } }
export async function POST(request: Request) { try { requireWebRequest(request); const body = await request.json() as Record<string, unknown>; return Response.json(importGrokApiKey(String(body.apiKey || ""), String(body.name || "")), { status: 201 }); } catch (error) { return errorToResponse(error); } }
