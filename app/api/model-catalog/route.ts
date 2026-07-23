import { createCodexModelsManifest } from "@/src/server/codex/models";
import { errorToResponse, HttpError } from "@/src/server/http/errors";
import { getTenantResources, requireTenantRequest } from "@/src/server/services/tenants";
import { requireWebRequest } from "@/src/server/services/webAccess";
import { listProviderModelIds } from "@/src/server/services/providerModels";
import { providerIds } from "@/src/shared/providerCapabilities";
import type { ProviderId } from "@/src/shared/types/entities";

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
    const provider = requestedProvider(searchParams.get("provider"));
    if (resources) {
      const data = provider
        ? [...new Set(resources.channels
            .filter((channel) => channel.provider === provider)
            .flatMap((channel) => channel.modelAllowlist))]
        : resources.models;
      return Response.json({ object: "list", provider: provider || "all", data });
    }
    const data = await listProviderModelIds(provider);
    return Response.json({ object: "list", provider: provider || "all", data });
  } catch (error) {
    return errorToResponse(error);
  }
}

function requestedProvider(value: string | null): ProviderId | undefined {
  if (value === null || value === "") return undefined;
  if (providerIds.includes(value as ProviderId)) return value as ProviderId;
  throw new HttpError(400, "invalid_provider", `Unknown provider: ${value}`);
}

function requireAuthorizedSession(request: Request) {
  try {
    requireWebRequest(request);
    return null;
  } catch {
    return requireTenantRequest(request);
  }
}
