import {
  createCodexModelsManifest,
  listCodexUpstreamModelIds,
  listGrokCatalogModelIds,
  listUpstreamModelIds,
} from "@/src/server/codex/models";
import { errorToResponse } from "@/src/server/http/errors";
import { getTenantResources, requireTenantRequest } from "@/src/server/services/tenants";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = requireAuthorizedSession(request);
    const resources = session
      ? await getTenantResources(session.tenant, session.user.id)
      : null;
    const modelAllowlist = resources?.models;
    const searchParams = new URL(request.url).searchParams;
    if (searchParams.get("format") === "codex") {
      return Response.json(await createCodexModelsManifest({ modelAllowlist }));
    }
    const provider = searchParams.get("provider");
    if (resources) {
      const data = provider
        ? [...new Set(resources.channels
            .filter((channel) => channel.provider === provider)
            .flatMap((channel) => channel.modelAllowlist))]
        : resources.models;
      return Response.json({ object: "list", provider: provider || "all", data });
    }
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
    return null;
  } catch {
    return requireTenantRequest(request);
  }
}
