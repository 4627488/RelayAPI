import { getActivityHeatmapStats } from "@/src/server/repositories/activityHeatmap";
import {
  renderActivityHeatmapMessageSvg,
  renderActivityHeatmapSvg,
  type ActivityHeatmapTheme,
} from "@/src/server/services/activityHeatmapSvg";
import { getPublicApiKeyById } from "@/src/server/services/apiKeys";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_CACHE_SECONDS = 300;
const MAX_CACHE_SECONDS = 86_400;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const theme = parseTheme(url.searchParams.get("theme"));
  try {
    const apiKeyId = cleanString(
      url.searchParams.get("key") || url.searchParams.get("apiKeyId"),
    );
    const apiKey = apiKeyId ? getPublicApiKeyById(apiKeyId) : null;
    if (apiKeyId && !apiKey) {
      return svgResponse(
        renderActivityHeatmapMessageSvg(
          "RelayAPI activity",
          "API key was not found.",
          theme,
        ),
        { status: 404, cacheSeconds: 0 },
      );
    }

    const stats = getActivityHeatmapStats({
      apiKeyId: apiKey?.id,
      apiKeyName: apiKey?.name,
      apiKeyPrefix: apiKey?.prefix,
      weeks: parseWeeks(url.searchParams.get("weeks")),
    });
    const svg = renderActivityHeatmapSvg(stats, {
      title: url.searchParams.get("title"),
      theme,
    });
    return svgResponse(svg, {
      cacheSeconds: parseCacheSeconds(url.searchParams.get("cacheSeconds")),
    });
  } catch (error) {
    console.error("Failed to render activity heatmap SVG", error);
    return svgResponse(
      renderActivityHeatmapMessageSvg(
        "RelayAPI activity",
        "Unable to render the activity heatmap.",
        theme,
      ),
      { status: 500, cacheSeconds: 0 },
    );
  }
}

function svgResponse(
  svg: string,
  options: { status?: number; cacheSeconds?: number } = {},
) {
  const status = options.status || 200;
  const cacheSeconds = options.cacheSeconds ?? DEFAULT_CACHE_SECONDS;
  return new Response(svg, {
    status,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control":
        cacheSeconds > 0 && status < 400
          ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=86400`
          : "no-store",
    },
  });
}

function parseTheme(value: string | null): ActivityHeatmapTheme {
  return value === "light" || value === "dark" ? value : "auto";
}

function parseWeeks(value: string | null) {
  const weeks = Number(value || 53);
  return Number.isFinite(weeks) ? weeks : 53;
}

function parseCacheSeconds(value: string | null) {
  const seconds = Number(value || DEFAULT_CACHE_SECONDS);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_CACHE_SECONDS;
  }
  return Math.max(60, Math.min(MAX_CACHE_SECONDS, Math.floor(seconds)));
}

function cleanString(value: string | null) {
  return typeof value === "string" ? value.trim() : "";
}
