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
  const searchParams = new URL(request.url).searchParams;
  const wantsCodexCatalog =
    searchParams.has("client_version") || searchParams.get("format") === "codex";
  return withCors(() => wantsCodexCatalog ? handleCodexModels(request) : handleModels(request));
}
