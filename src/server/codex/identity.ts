const DEFAULT_ORIGINATOR = "codex_cli_rs";
export const MIN_CODEX_CLIENT_VERSION = "0.144.0";
export const DEFAULT_CODEX_CLIENT_VERSION = "0.144.1";
export const DEFAULT_CODEX_USER_AGENT =
  `codex_cli_rs/${DEFAULT_CODEX_CLIENT_VERSION} (Mac OS 26.3.1; arm64) iTerm.app/3.6.9`;

const OFFICIAL_ORIGINATORS = new Set([
  "codex_cli_rs",
  "codex-tui",
  "codex_vscode",
  "codex_desktop",
]);

export function pairCodexIdentity(input: {
  userAgent?: string | null;
  originator?: string | null;
  version?: string | null;
}) {
  const userAgent = String(input.userAgent || "").trim();
  const paired = originatorFromUserAgent(userAgent);
  const originator = paired || DEFAULT_ORIGINATOR;
  const pairedUserAgent = paired ? normalizeUserAgentOriginator(userAgent, paired) : DEFAULT_CODEX_USER_AGENT;
  const version = normalizeCodexVersion(input.version);
  return { userAgent: pairedUserAgent, originator, version };
}

function originatorFromUserAgent(userAgent: string) {
  const slash = userAgent.indexOf("/");
  if (slash <= 0) return "";
  const leading = canonicalOriginator(userAgent.slice(0, slash).trim());
  if (isOfficialOriginator(leading)) return leading;
  const trailer = /\(([^();]+);\s*[^()]+\)\s*$/.exec(userAgent)?.[1]?.trim() || "";
  const trailerOriginator = canonicalOriginator(trailer);
  return isOfficialOriginator(trailerOriginator) ? trailerOriginator : "";
}

function canonicalOriginator(value: string) {
  if (!value || value.length > 64 || /[^\x20-\x7e]/.test(value) || value.includes("/")) return "";
  const lower = value.toLowerCase();
  if (OFFICIAL_ORIGINATORS.has(lower)) return lower;
  return lower.startsWith("codex ") ? value : "";
}

function isOfficialOriginator(value: string) {
  return OFFICIAL_ORIGINATORS.has(value) || value.startsWith("Codex ");
}

function normalizeUserAgentOriginator(userAgent: string, originator: string) {
  const slash = userAgent.indexOf("/");
  return slash > 0 ? `${originator}${userAgent.slice(slash)}` : DEFAULT_CODEX_USER_AGENT;
}

function normalizeCodexVersion(value?: string | null) {
  const version = String(value || "").trim();
  if (!version) return "";
  return compareVersions(version, MIN_CODEX_CLIENT_VERSION) < 0
    ? DEFAULT_CODEX_CLIENT_VERSION
    : version;
}

function compareVersions(left: string, right: string) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function versionParts(value: string) {
  return value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}
