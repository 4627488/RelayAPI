import { corsPreflightResponse, withCors } from "@/src/server/http/cors";
import { handleCodexModels } from "@/src/server/http/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() { return corsPreflightResponse(); }
export async function GET(request: Request) { return withCors(() => handleCodexModels(request)); }
