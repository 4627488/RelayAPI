import * as React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "./styles.css";

const queryClient = new QueryClient();
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "";

type Overview = { counts: { api_keys: number; codex_credentials: number; channels: number; request_logs: number } };
type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  scopes: string[];
  model_allowlist: string[];
  channel_allowlist: string[];
  token_limit_daily?: number | null;
  rate_limit_per_minute?: number | null;
  expires_at?: string | null;
  created_at: string;
  last_used_at?: string | null;
};
type CreatedApiKey = { api_key: ApiKey; key: string };
type CredentialProxy = { enabled: boolean; type: string; host: string; port: number; username: string; password?: string | null };
type Credential = {
  id: string;
  label: string;
  email: string;
  account_id: string;
  plan_type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  user_agent?: string | null;
  upstream_transport: string;
  proxy?: CredentialProxy | null;
  token_expires_at?: string | null;
  last_refresh_at?: string | null;
  last_used_at?: string | null;
  created_at: string;
};
type Channel = {
  id: string;
  name: string;
  base_url: string;
  credential_id?: string | null;
  enabled: boolean;
  priority: number;
  weight: number;
  model_allowlist: string[];
  status: string;
  health_score: number;
  last_error?: string | null;
  created_at: string;
};
type ProxyPoolItem = {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  username: string;
  password_set: boolean;
  enabled: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
};
type Tenant = {
  id: string;
  name: string;
  owner_email: string;
  enabled: boolean;
  max_api_keys?: number | null;
  token_limit_daily?: number | null;
  rate_limit_per_minute?: number | null;
  model_allowlist: string[];
  channel_allowlist: string[];
  allow_custom_proxy: boolean;
  allow_custom_user_agent: boolean;
  user_agent?: string | null;
  expires_at?: string | null;
  created_at: string;
  deleted_at?: string | null;
};
type CreatedInvite = { invite_id: string; token: string; activation_url: string; expires_at: string };
type RequestLog = {
  id: string;
  started_at: string;
  method: string;
  path: string;
  request_type: string;
  stream: boolean;
  model: string;
  status_code: number;
  latency_ms: number;
  api_key_prefix?: string | null;
  channel_id?: string | null;
  credential_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};
type Models = { data: Array<{ id: string; owned_by: string }> };
type Settings = { codex_base_url: string; codex_default_model: string; codex_user_agent: string; codex_user_agent_source: string };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json() as Promise<T>;
}

async function deleteJson(path: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}${path}`, { method: "DELETE", credentials: "include" });
  if (!response.ok) throw new Error(await errorText(response));
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json() as Promise<T>;
}

async function errorText(response: Response) {
  try {
    const body = await response.json();
    return body?.error?.message || `Request failed: ${response.status}`;
  } catch {
    return `Request failed: ${response.status}`;
  }
}

function App() {
  const session = useQuery({ queryKey: ["session"], queryFn: () => getJson<{ authenticated: boolean }>("/api/auth/web-session") });
  if (session.isLoading) return <div className="center">Loading RelayAPI...</div>;
  if (!session.data?.authenticated) return <Login onLoggedIn={() => session.refetch()} />;
  return <Dashboard />;
}

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [accessKey, setAccessKey] = React.useState("");
  const [error, setError] = React.useState("");
  const login = useMutation({
    mutationFn: () => postJson<{ ok: boolean }>("/api/auth/web-login", { access_key: accessKey }),
    onSuccess: onLoggedIn,
    onError: (err) => setError(err instanceof Error ? err.message : "Login failed")
  });
  return (
    <main className="login">
      <section className="login-card">
        <p>RelayAPI</p>
        <h1>Enter web access key</h1>
        <input value={accessKey} onChange={(event) => setAccessKey(event.target.value)} placeholder="relay_web_..." />
        <button onClick={() => login.mutate()} disabled={!accessKey || login.isPending}>{login.isPending ? "Checking..." : "Sign in"}</button>
        {error ? <span className="error">{error}</span> : null}
      </section>
    </main>
  );
}

function Dashboard() {
  const client = useQueryClient();
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => getJson<Overview>("/api/admin/overview") });
  const models = useQuery({ queryKey: ["models"], queryFn: () => getJson<Models>("/v1/models") });
  const apiKeys = useQuery({ queryKey: ["apiKeys"], queryFn: () => getJson<ApiKey[]>("/api/admin/api-keys") });
  const credentials = useQuery({ queryKey: ["credentials"], queryFn: () => getJson<Credential[]>("/api/admin/codex/credentials") });
  const channels = useQuery({ queryKey: ["channels"], queryFn: () => getJson<Channel[]>("/api/admin/channels") });
  const proxyPool = useQuery({ queryKey: ["proxyPool"], queryFn: () => getJson<ProxyPoolItem[]>("/api/admin/proxy-pool") });
  const tenants = useQuery({ queryKey: ["tenants"], queryFn: () => getJson<Tenant[]>("/api/admin/tenants") });
  const logs = useQuery({ queryKey: ["logs"], queryFn: () => getJson<RequestLog[]>("/api/admin/request-logs") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJson<Settings>("/api/admin/settings") });
  const logout = useMutation({ mutationFn: () => postJson("/api/auth/web-logout"), onSuccess: () => location.reload() });

  const refreshControlPlane = () => {
    client.invalidateQueries({ queryKey: ["overview"] });
    client.invalidateQueries({ queryKey: ["apiKeys"] });
    client.invalidateQueries({ queryKey: ["credentials"] });
    client.invalidateQueries({ queryKey: ["channels"] });
  };

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">RelayAPI</div>
        <nav>
          <a href="#overview">Overview</a>
          <a href="#keys">API Keys</a>
          <a href="#credentials">Credentials</a>
          <a href="#channels">Channels</a>
          <a href="#proxy">Proxy Pool</a>
          <a href="#tenants">Tenants</a>
          <a href="#settings">Settings</a>
          <a href="#logs">Logs</a>
        </nav>
        <button className="ghost" onClick={() => logout.mutate()}>Logout</button>
      </aside>
      <section className="content">
        <header className="hero">
          <p>Rust rewrite</p>
          <h1>Codex OAuth relay control plane</h1>
          <span>Axum backend, SeaORM SQLite schema, Vite admin console.</span>
        </header>

        <section id="overview" className="grid">
          <Metric title="API Keys" value={overview.data?.counts.api_keys} loading={overview.isLoading} />
          <Metric title="Credentials" value={overview.data?.counts.codex_credentials} loading={overview.isLoading} />
          <Metric title="Channels" value={overview.data?.counts.channels} loading={overview.isLoading} />
          <Metric title="Logs" value={overview.data?.counts.request_logs} loading={overview.isLoading} />
        </section>

        <ApiKeyPanel apiKeys={apiKeys.data || []} onChanged={refreshControlPlane} />
        <CredentialPanel credentials={credentials.data || []} onChanged={refreshControlPlane} />
        <ChannelPanel channels={channels.data || []} credentials={credentials.data || []} onChanged={refreshControlPlane} />
        <ProxyPoolPanel proxyPool={proxyPool.data || []} onChanged={() => client.invalidateQueries({ queryKey: ["proxyPool"] })} />
        <TenantPanel tenants={tenants.data || []} onChanged={() => client.invalidateQueries({ queryKey: ["tenants"] })} />
        <SettingsPanel settings={settings.data} onChanged={() => client.invalidateQueries({ queryKey: ["settings"] })} />
        <section className="panel">
          <div className="panel-head"><div><h2>Models</h2><p>Served by `/v1/models`.</p></div></div>
          <div className="chips">{(models.data?.data || []).map((model) => <span key={model.id}>{model.id}</span>)}</div>
        </section>
        <LogPanel logs={logs.data || []} onRefresh={() => logs.refetch()} />
      </section>
    </main>
  );
}

function SettingsPanel({ settings, onChanged }: { settings?: Settings; onChanged: () => void }) {
  const [userAgent, setUserAgent] = React.useState("");
  React.useEffect(() => setUserAgent(settings?.codex_user_agent || ""), [settings?.codex_user_agent]);
  const save = useMutation({
    mutationFn: () => patchJson<Settings>("/api/admin/settings", { codex_user_agent: userAgent }),
    onSuccess: onChanged
  });
  return (
    <section id="settings" className="panel">
      <div className="panel-head"><div><h2>Settings</h2><p>Base URL and default model come from environment; User-Agent can be overridden at runtime.</p></div></div>
      <div className="settings-grid"><span>Base URL</span><code>{settings?.codex_base_url || "-"}</code><span>Default model</span><code>{settings?.codex_default_model || "-"}</code><span>User-Agent source</span><code>{settings?.codex_user_agent_source || "-"}</code></div>
      <div className="form-row"><input value={userAgent} onChange={(event) => setUserAgent(event.target.value)} placeholder="Codex User-Agent" /><button onClick={() => save.mutate()}>Save</button></div>
    </section>
  );
}

function ApiKeyPanel({ apiKeys, onChanged }: { apiKeys: ApiKey[]; onChanged: () => void }) {
  const [name, setName] = React.useState("Default relay key");
  const [models, setModels] = React.useState("");
  const [dailyLimit, setDailyLimit] = React.useState("");
  const [created, setCreated] = React.useState("");
  const create = useMutation({
    mutationFn: () => postJson<CreatedApiKey>("/api/admin/api-keys", {
      name,
      model_allowlist: splitList(models),
      token_limit_daily: optionalNumber(dailyLimit)
    }),
    onSuccess: (result) => { setCreated(result.key); onChanged(); }
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => patchJson<ApiKey>(`/api/admin/api-keys/${id}`, body),
    onSuccess: onChanged
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteJson(`/api/admin/api-keys/${id}`), onSuccess: onChanged });
  return (
    <section id="keys" className="panel">
      <div className="panel-head"><div><h2>API Keys</h2><p>Clients call `/v1/*` with these RelayAPI keys.</p></div></div>
      <div className="form-grid">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Key name" />
        <input value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} placeholder="Daily token limit, optional" inputMode="numeric" />
        <textarea value={models} onChange={(event) => setModels(event.target.value)} placeholder="Model allowlist, comma or newline separated" />
        <button onClick={() => create.mutate()} disabled={!name || create.isPending}>Create key</button>
      </div>
      {created ? <div className="secret"><b>Copy now:</b><code>{created}</code></div> : null}
      <Table rows={apiKeys.map((item) => [
        item.name,
        item.prefix,
        item.enabled ? "enabled" : "disabled",
        item.model_allowlist.length ? item.model_allowlist.join(", ") : "all models",
        item.token_limit_daily ?? "unlimited",
        item.last_used_at || "never",
        <div className="actions"><button onClick={() => patch.mutate({ id: item.id, body: { enabled: !item.enabled } })}>{item.enabled ? "Disable" : "Enable"}</button><button className="danger" onClick={() => remove.mutate(item.id)}>Delete</button></div>
      ])} />
    </section>
  );
}

function CredentialPanel({ credentials, onChanged }: { credentials: Credential[]; onChanged: () => void }) {
  const [label, setLabel] = React.useState("");
  const [tokens, setTokens] = React.useState("");
  const [callbackUrl, setCallbackUrl] = React.useState("");
  const [details, setDetails] = React.useState("");
  const importTokens = useMutation({
    mutationFn: () => postJson("/api/admin/codex/credentials/import", { label: optionalString(label), tokens: JSON.parse(tokens) }),
    onSuccess: () => { setLabel(""); setTokens(""); onChanged(); }
  });
  const oauthStart = useMutation({
    mutationFn: () => postJson<{ auth_url: string }>("/api/admin/codex/credentials/oauth/start", {}),
    onSuccess: (result) => window.open(result.auth_url, "_blank", "noopener,noreferrer")
  });
  const oauthFinish = useMutation({
    mutationFn: () => postJson("/api/admin/codex/credentials/oauth/callback", { callback_url: callbackUrl }),
    onSuccess: () => { setCallbackUrl(""); onChanged(); }
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => patchJson<Credential>(`/api/admin/codex/credentials/${id}`, body),
    onSuccess: onChanged
  });
  const refresh = useMutation({ mutationFn: (id: string) => postJson<Credential>(`/api/admin/codex/credentials/${id}/refresh`, {}), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: (id: string) => deleteJson(`/api/admin/codex/credentials/${id}`), onSuccess: onChanged });
  const exportOne = useMutation({
    mutationFn: (id: string) => getJson<Record<string, unknown>>(`/api/admin/codex/credentials/${id}/export`),
    onSuccess: (result) => { setDetails(JSON.stringify(result, null, 2)); downloadJson("relayapi-codex-credential.json", result); }
  });
  const exportAll = useMutation({
    mutationFn: () => getJson<Record<string, unknown>>("/api/admin/codex/credentials/export"),
    onSuccess: (result) => { setDetails(JSON.stringify(result, null, 2)); downloadJson("relayapi-codex-credentials.json", result); }
  });
  const quota = useMutation({
    mutationFn: (id: string) => getJson<Record<string, unknown>>(`/api/admin/codex/credentials/${id}/quota`),
    onSuccess: (result) => setDetails(JSON.stringify(result, null, 2))
  });
  return (
    <section id="credentials" className="panel">
      <div className="panel-head"><div><h2>Codex Credentials</h2><p>OAuth tokens are encrypted with the local RelayAPI secret.</p></div><div className="actions"><button onClick={() => oauthStart.mutate()}>Start OAuth</button><button onClick={() => exportAll.mutate()}>Export all</button></div></div>
      <div className="form-row"><input value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="Paste callback URL" /><button onClick={() => oauthFinish.mutate()} disabled={!callbackUrl}>Finish OAuth</button></div>
      <div className="form-grid">
        <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Credential label, optional" />
        <textarea value={tokens} onChange={(event) => setTokens(event.target.value)} placeholder='Import token JSON: {"access_token":"...","refresh_token":"..."}' />
        <button onClick={() => importTokens.mutate()} disabled={!tokens}>Import tokens</button>
      </div>
      <Table rows={credentials.map((item) => [
        item.label || item.email || item.id,
        item.email || "-",
        item.account_id || "-",
        item.plan_type || "-",
        item.enabled ? "enabled" : "disabled",
        <select value={item.upstream_transport} onChange={(event) => patch.mutate({ id: item.id, body: { upstream_transport: event.target.value } })}><option value="http">http</option><option value="websocket">websocket</option></select>,
        item.token_expires_at || "unknown",
        <div className="actions"><button onClick={() => patch.mutate({ id: item.id, body: { enabled: !item.enabled } })}>{item.enabled ? "Disable" : "Enable"}</button><button onClick={() => refresh.mutate(item.id)}>Refresh</button><button onClick={() => quota.mutate(item.id)}>Quota</button><button onClick={() => exportOne.mutate(item.id)}>Export</button><button className="danger" onClick={() => remove.mutate(item.id)}>Delete</button></div>
      ])} />
      {details ? <pre className="json-output">{details}</pre> : null}
    </section>
  );
}

function ChannelPanel({ channels, credentials, onChanged }: { channels: Channel[]; credentials: Credential[]; onChanged: () => void }) {
  const [name, setName] = React.useState("Codex");
  const [credentialId, setCredentialId] = React.useState("");
  const [priority, setPriority] = React.useState("100");
  const [models, setModels] = React.useState("");
  const create = useMutation({
    mutationFn: () => postJson("/api/admin/channels", { name, credential_id: credentialId, priority: optionalNumber(priority), model_allowlist: splitList(models) }),
    onSuccess: onChanged
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => patchJson<Channel>(`/api/admin/channels/${id}`, body),
    onSuccess: onChanged
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteJson(`/api/admin/channels/${id}`), onSuccess: onChanged });
  return (
    <section id="channels" className="panel">
      <div className="panel-head"><div><h2>Channels</h2><p>Credential-backed routing targets for relay traffic.</p></div></div>
      <div className="form-grid">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Channel name" />
        <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">Select credential</option>{credentials.map((item) => <option key={item.id} value={item.id}>{item.email || item.label || item.id}</option>)}</select>
        <input value={priority} onChange={(event) => setPriority(event.target.value)} placeholder="Priority" inputMode="numeric" />
        <textarea value={models} onChange={(event) => setModels(event.target.value)} placeholder="Model allowlist, comma or newline separated" />
        <button onClick={() => create.mutate()} disabled={!credentialId || create.isPending}>Create channel</button>
      </div>
      <Table rows={channels.map((item) => [
        item.name,
        item.base_url,
        item.enabled ? "enabled" : "disabled",
        `${item.status} (${item.health_score})`,
        `p${item.priority} / w${item.weight}`,
        item.model_allowlist.length ? item.model_allowlist.join(", ") : "all models",
        item.last_error || "-",
        <div className="actions"><button onClick={() => patch.mutate({ id: item.id, body: { enabled: !item.enabled } })}>{item.enabled ? "Disable" : "Enable"}</button><button onClick={() => patch.mutate({ id: item.id, body: { status: "healthy" } })}>Mark healthy</button><button className="danger" onClick={() => remove.mutate(item.id)}>Delete</button></div>
      ])} />
    </section>
  );
}

function ProxyPoolPanel({ proxyPool, onChanged }: { proxyPool: ProxyPoolItem[]; onChanged: () => void }) {
  const [name, setName] = React.useState("Codex proxy");
  const [type, setType] = React.useState("socks5h");
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState("1080");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const create = useMutation({
    mutationFn: () => postJson<ProxyPoolItem>("/api/admin/proxy-pool", { name, type, host, port: Number(port), username, password: optionalString(password), enabled: true, notes }),
    onSuccess: () => { setPassword(""); onChanged(); }
  });
  const patch = useMutation({
    mutationFn: ({ item, enabled }: { item: ProxyPoolItem; enabled: boolean }) => patchJson<ProxyPoolItem>(`/api/admin/proxy-pool/${item.id}`, proxyPayload(item, enabled)),
    onSuccess: onChanged
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteJson(`/api/admin/proxy-pool/${id}`), onSuccess: onChanged });
  return (
    <section id="proxy" className="panel">
      <div className="panel-head"><div><h2>Proxy Pool</h2><p>Reusable SOCKS proxies for credential routing.</p></div></div>
      <div className="form-grid">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Proxy name" />
        <select value={type} onChange={(event) => setType(event.target.value)}><option value="socks5h">socks5h</option><option value="socks5">socks5</option></select>
        <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="Host" />
        <input value={port} onChange={(event) => setPort(event.target.value)} placeholder="Port" inputMode="numeric" />
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username, optional" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password, optional" type="password" />
        <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
        <button onClick={() => create.mutate()} disabled={!host || create.isPending}>Add proxy</button>
      </div>
      <Table rows={proxyPool.map((item) => [
        item.name,
        `${item.type}://${item.host}:${item.port}`,
        item.username || "no auth",
        item.password_set ? "password set" : "no password",
        item.enabled ? "enabled" : "disabled",
        item.last_used_at || "never",
        item.notes || "-",
        <div className="actions"><button onClick={() => patch.mutate({ item, enabled: !item.enabled })}>{item.enabled ? "Disable" : "Enable"}</button><button className="danger" onClick={() => remove.mutate(item.id)}>Delete</button></div>
      ])} />
    </section>
  );
}

function TenantPanel({ tenants, onChanged }: { tenants: Tenant[]; onChanged: () => void }) {
  const [name, setName] = React.useState("Tenant");
  const [ownerEmail, setOwnerEmail] = React.useState("");
  const [maxKeys, setMaxKeys] = React.useState("");
  const [dailyLimit, setDailyLimit] = React.useState("");
  const [inviteDetails, setInviteDetails] = React.useState("");
  const create = useMutation({
    mutationFn: () => postJson<Tenant>("/api/admin/tenants", { name, owner_email: ownerEmail, max_api_keys: optionalNumber(maxKeys), token_limit_daily: optionalNumber(dailyLimit), enabled: true }),
    onSuccess: onChanged
  });
  const patch = useMutation({
    mutationFn: ({ item, enabled }: { item: Tenant; enabled: boolean }) => patchJson<Tenant>(`/api/admin/tenants/${item.id}`, tenantPayload(item, enabled)),
    onSuccess: onChanged
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteJson(`/api/admin/tenants/${id}`), onSuccess: onChanged });
  const invite = useMutation({
    mutationFn: (item: Tenant) => postJson<CreatedInvite>(`/api/admin/tenants/${item.id}/invite`, { email: item.owner_email }),
    onSuccess: (result) => setInviteDetails(JSON.stringify(result, null, 2))
  });
  return (
    <section id="tenants" className="panel">
      <div className="panel-head"><div><h2>Tenants</h2><p>Isolated customers with their own sessions, keys, and limits.</p></div></div>
      <div className="form-grid">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Tenant name" />
        <input value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="Owner email" />
        <input value={maxKeys} onChange={(event) => setMaxKeys(event.target.value)} placeholder="Max API keys, optional" inputMode="numeric" />
        <input value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} placeholder="Daily token limit, optional" inputMode="numeric" />
        <button onClick={() => create.mutate()} disabled={!ownerEmail || create.isPending}>Create tenant</button>
      </div>
      <Table rows={tenants.map((item) => [
        item.name,
        item.owner_email,
        item.enabled && !item.deleted_at ? "enabled" : "disabled",
        item.max_api_keys ?? "unlimited keys",
        item.token_limit_daily ?? "unlimited tokens",
        item.allow_custom_proxy ? "custom proxy" : "managed proxy",
        item.expires_at || "no expiry",
        <div className="actions"><button onClick={() => patch.mutate({ item, enabled: !item.enabled })}>{item.enabled ? "Disable" : "Enable"}</button><button onClick={() => invite.mutate(item)}>Invite</button><button className="danger" onClick={() => remove.mutate(item.id)}>Delete</button></div>
      ])} />
      {inviteDetails ? <div className="secret"><b>Tenant invite:</b><pre>{inviteDetails}</pre></div> : null}
    </section>
  );
}

function LogPanel({ logs, onRefresh }: { logs: RequestLog[]; onRefresh: () => void }) {
  return (
    <section id="logs" className="panel">
      <div className="panel-head"><div><h2>Request Logs</h2><p>Latest relay attempts.</p></div><button onClick={onRefresh}>Refresh</button></div>
      <Table rows={logs.map((item) => [item.started_at, item.method, item.path, item.model || "-", item.status_code, `${item.latency_ms}ms`, item.channel_id || "-", item.error_message || ""])} />
    </section>
  );
}

function Metric({ title, value, loading }: { title: string; value?: number; loading: boolean }) {
  return <article className="metric"><span>{title}</span><strong>{loading ? "..." : value ?? 0}</strong></article>;
}

function Table({ rows }: { rows: Array<Array<React.ReactNode>> }) {
  if (rows.length === 0) return <div className="empty">No records yet.</div>;
  return <div className="table">{rows.map((row, index) => <div className="tr" key={index}>{row.map((cell, cellIndex) => <div className="td" key={cellIndex}>{cell}</div>)}</div>)}</div>;
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function proxyPayload(item: ProxyPoolItem, enabled: boolean) {
  return { name: item.name, type: item.type, host: item.host, port: item.port, username: item.username, enabled, notes: item.notes };
}

function tenantPayload(item: Tenant, enabled: boolean) {
  return {
    name: item.name,
    owner_email: item.owner_email,
    enabled,
    max_api_keys: item.max_api_keys,
    token_limit_daily: item.token_limit_daily,
    rate_limit_per_minute: item.rate_limit_per_minute,
    model_allowlist: item.model_allowlist,
    channel_allowlist: item.channel_allowlist,
    allow_custom_proxy: item.allow_custom_proxy,
    allow_custom_user_agent: item.allow_custom_user_agent,
    user_agent: item.user_agent,
    expires_at: item.expires_at
  };
}

function downloadJson(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
