import { corsPreflightResponse, withCors } from "@/src/server/http/cors";
import { handleCodexModels, handleModels } from "@/src/server/http/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin App Router adapter only; channel routing and credential selection happen
// automatically in the server service layer, not in UI or route modules.
export function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(request: Request) {
  return withCors(() => new URL(request.url).searchParams.has("client_version") ? handleCodexModels(request) : handleModels(request));
}
