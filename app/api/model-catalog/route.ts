import {
  createCodexModelsManifest,
  listCodexUpstreamModelIds,
  listGrokCatalogModelIds,
  listUpstreamModelIds,
} from "@/src/server/codex/models";
import { errorToResponse } from "@/src/server/http/errors";
import { requireTenantRequest } from "@/src/server/services/tenants";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const modelAllowlist = requireAuthorizedSession(request);
    const searchParams = new URL(request.url).searchParams;
    if (searchParams.get("format") === "codex") {
      return Response.json(await createCodexModelsManifest({ modelAllowlist }));
    }
    const provider = searchParams.get("provider");
    const data = provider === "grok"
      ? await listGrokCatalogModelIds()
      : provider === "codex"
        ? await listCodexUpstreamModelIds()
        : await listUpstreamModelIds();
    return Response.json({ object: "list", provider: provider || "all", data });
  } catch (error) {
    return errorToResponse(error);
  }
}

function requireAuthorizedSession(request: Request) {
  try {
    requireWebRequest(request);
    return undefined;
  } catch {
    return requireTenantRequest(request).tenant.modelAllowlist;
  }
}
