import "server-only";

import type { ActivityHeatmapStats } from "@/src/shared/types/entities";

export type ActivityHeatmapTheme = "auto" | "light" | "dark";

export interface ActivityHeatmapSvgOptions {
  title?: string | null;
  theme?: ActivityHeatmapTheme;
}

const CELL_SIZE = 11;
const CELL_GAP = 3;
const GRID_LEFT = 46;
const GRID_TOP = 56;
const GRID_RIGHT = 22;
const GRID_BOTTOM = 42;
const WEEKDAY_LABELS = [
  ["Mon", 1],
  ["Wed", 3],
  ["Fri", 5],
] as const;
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function renderActivityHeatmapSvg(
  stats: ActivityHeatmapStats,
  options: ActivityHeatmapSvgOptions = {},
) {
  const weeks = Math.max(1, stats.weeks);
  const gridWidth = weeks * CELL_SIZE + (weeks - 1) * CELL_GAP;
  const gridHeight = 7 * CELL_SIZE + 6 * CELL_GAP;
  const width = GRID_LEFT + gridWidth + GRID_RIGHT;
  const height = GRID_TOP + gridHeight + GRID_BOTTOM;
  const title = cleanTitle(options.title) || defaultTitle(stats);
  const description = `${formatNumber(stats.totalRequests)} requests across ${formatNumber(stats.activeDays)} active days from ${stats.from} to ${stats.to}.`;
  const titleId = "relayapi-activity-title";
  const descId = "relayapi-activity-desc";
  const daysByDate = new Map(stats.days.map((day) => [day.date, day]));
  const subtitle = `${formatNumber(stats.totalRequests)} requests · ${formatNumber(stats.totalTokens)} tokens · ${formatNumber(stats.currentStreakDays)} day current streak`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${titleId} ${descId}">
  <title id="${titleId}">${escapeXml(title)}</title>
  <desc id="${descId}">${escapeXml(description)}</desc>
  <style>
${themeCss(options.theme || "auto")}
  </style>
  <text class="title" x="0" y="18">${escapeXml(title)}</text>
  <text class="subtitle" x="0" y="38">${escapeXml(subtitle)}</text>
${monthLabels(stats).join("\n")}
${WEEKDAY_LABELS.map(([label, index]) => {
  const y = GRID_TOP + index * (CELL_SIZE + CELL_GAP) + CELL_SIZE - 1;
  return `  <text class="axis" x="0" y="${y}">${label}</text>`;
}).join("\n")}
${heatmapCells(stats, daysByDate).join("\n")}
  <text class="legend-label" x="${GRID_LEFT}" y="${height - 10}">Less</text>
${[0, 1, 2, 3, 4]
  .map((level, index) => {
    const x = GRID_LEFT + 34 + index * (CELL_SIZE + 4);
    return `  <rect class="cell level-${level}" x="${x}" y="${height - 21}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="2" />`;
  })
  .join("\n")}
  <text class="legend-label" x="${GRID_LEFT + 34 + 5 * (CELL_SIZE + 4) + 2}" y="${height - 10}">More</text>
</svg>`;
}

export function renderActivityHeatmapMessageSvg(
  title: string,
  message: string,
  theme: ActivityHeatmapTheme = "auto",
) {
  const safeTitle = cleanTitle(title) || "RelayAPI activity";
  const safeMessage = message.trim() || "No activity data available.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120" viewBox="0 0 640 120" role="img" aria-labelledby="relayapi-message-title relayapi-message-desc">
  <title id="relayapi-message-title">${escapeXml(safeTitle)}</title>
  <desc id="relayapi-message-desc">${escapeXml(safeMessage)}</desc>
  <style>
${themeCss(theme)}
  </style>
  <rect class="message-panel" x="1" y="1" width="638" height="118" rx="8" />
  <text class="title" x="24" y="42">${escapeXml(safeTitle)}</text>
  <text class="subtitle" x="24" y="70">${escapeXml(safeMessage)}</text>
</svg>`;
}

function heatmapCells(
  stats: ActivityHeatmapStats,
  daysByDate: Map<string, ActivityHeatmapStats["days"][number]>,
) {
  const cells: string[] = [];
  for (let week = 0; week < stats.weeks; week += 1) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = addUtcDays(stats.from, week * 7 + weekday);
      if (date > stats.to) {
        continue;
      }
      const day = daysByDate.get(date);
      const level = day?.level || 0;
      const x = GRID_LEFT + week * (CELL_SIZE + CELL_GAP);
      const y = GRID_TOP + weekday * (CELL_SIZE + CELL_GAP);
      const label = day
        ? `${day.date}: ${formatNumber(day.requestCount)} requests, ${formatNumber(day.totalTokens)} tokens`
        : `${date}: 0 requests`;
      cells.push(
        `  <rect class="cell level-${level}" x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="2"><title>${escapeXml(label)}</title></rect>`,
      );
    }
  }
  return cells;
}

function monthLabels(stats: ActivityHeatmapStats) {
  const labels: string[] = [];
  let previousMonth = "";
  for (let week = 0; week < stats.weeks; week += 1) {
    const weekStart = addUtcDays(stats.from, week * 7);
    const visibleDate = weekStart > stats.to ? stats.to : weekStart;
    const month = visibleDate.slice(5, 7);
    if (month === previousMonth) {
      continue;
    }
    previousMonth = month;
    const date = new Date(`${visibleDate}T00:00:00.000Z`);
    const label = MONTH_LABELS[date.getUTCMonth()] || month;
    const x = GRID_LEFT + week * (CELL_SIZE + CELL_GAP);
    labels.push(`  <text class="axis month" x="${x}" y="${GRID_TOP - 9}">${label}</text>`);
  }
  return labels;
}

function defaultTitle(stats: ActivityHeatmapStats) {
  if (stats.scope === "api_key") {
    return `${stats.apiKeyName || stats.apiKeyPrefix || "API key"} activity`;
  }
  return "RelayAPI activity";
}

function themeCss(theme: ActivityHeatmapTheme) {
  const common = `    svg {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .title {
      fill: var(--text);
      font-size: 15px;
      font-weight: 700;
    }
    .subtitle,
    .axis,
    .legend-label {
      fill: var(--muted);
      font-size: 10px;
    }
    .subtitle {
      font-size: 11px;
    }
    .month {
      font-size: 9px;
    }
    .cell {
      stroke: var(--cell-stroke);
      stroke-width: 1;
      shape-rendering: geometricPrecision;
    }
    .message-panel {
      fill: var(--message-bg);
      stroke: var(--cell-stroke);
    }
    .level-0 { fill: var(--level-0); }
    .level-1 { fill: var(--level-1); }
    .level-2 { fill: var(--level-2); }
    .level-3 { fill: var(--level-3); }
    .level-4 { fill: var(--level-4); }`;

  if (theme === "light") {
    return `    :root { ${lightVariables()} }
${common}`;
  }
  if (theme === "dark") {
    return `    :root { ${darkVariables()} }
${common}`;
  }
  return `    :root { ${lightVariables()} }
    @media (prefers-color-scheme: dark) {
      :root { ${darkVariables()} }
    }
${common}`;
}

function lightVariables() {
  return [
    "--text:#0f172a",
    "--muted:#64748b",
    "--message-bg:#ffffff",
    "--cell-stroke:#dbeafe",
    "--level-0:#edf4f8",
    "--level-1:#d8f3ff",
    "--level-2:#9ee5ff",
    "--level-3:#45c5f5",
    "--level-4:#0284c7",
  ].join(";");
}

function darkVariables() {
  return [
    "--text:#dbeafe",
    "--muted:#93a4b8",
    "--message-bg:#0f172a",
    "--cell-stroke:#1e3a4c",
    "--level-0:#172331",
    "--level-1:#0e3a4c",
    "--level-2:#075985",
    "--level-3:#0284c7",
    "--level-4:#7dd3fc",
  ].join(";");
}

function cleanTitle(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function formatNumber(value: number) {
  return Math.max(0, Math.floor(value || 0)).toLocaleString("en-US");
}

function addUtcDays(dateKey: string, deltaDays: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}
