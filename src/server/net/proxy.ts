import "server-only";

import nodeFetch, {
  type RequestInit as NodeFetchRequestInit,
} from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { CredentialProxyConfig } from "@/src/shared/types/entities";

const proxyAgents = new Map<string, SocksProxyAgent>();

export async function proxiedFetch(
  url: string,
  init: RequestInit = {},
  proxy: CredentialProxyConfig | null | undefined,
): Promise<Response> {
  if (!proxy?.enabled) {
    return fetch(url, init);
  }

  const agent = getProxyAgent(proxy);
  try {
    const response = await nodeFetch(url, {
      method: init.method,
      headers: init.headers as NodeFetchRequestInit["headers"],
      body: init.body as NodeFetchRequestInit["body"],
      signal: init.signal as NodeFetchRequestInit["signal"],
      redirect: init.redirect as NodeFetchRequestInit["redirect"],
      agent,
    });

    const headers = new Headers();
    response.headers.forEach((value, name) => headers.append(name, value));
    const body = response.body as BodyInit | null;

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    throw new Error(
      `Proxy request failed via ${publicProxyLabel(proxy)}: ${errorMessage(error)}`,
    );
  }
}

function getProxyAgent(proxy: CredentialProxyConfig) {
  const url = proxyUrl(proxy);
  const existing = proxyAgents.get(url);
  if (existing) {
    return existing;
  }
  const agent = new SocksProxyAgent(url, {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 256,
    maxFreeSockets: 32,
    timeout: 300_000,
  });
  proxyAgents.set(url, agent);
  return agent;
}

function proxyUrl(proxy: CredentialProxyConfig) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : "";
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function publicProxyLabel(proxy: CredentialProxyConfig) {
  return `${proxy.type}://${proxy.host}:${proxy.port}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "request failed";
}
