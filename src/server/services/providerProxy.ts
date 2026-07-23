import "server-only";

import { getProxyPoolCredentialProxy } from "@/src/server/services/proxyPool";
import { getGlobalProxySetting } from "@/src/server/services/settings";
import type { CredentialProxyConfig } from "@/src/shared/types/entities";

export function resolveProviderCredentialProxy(input: {
  proxy: CredentialProxyConfig | null;
  proxyPoolId: string | null;
  useGlobalProxy: boolean;
  tenantProxy?: CredentialProxyConfig | null;
}) {
  if (input.proxy?.enabled) return input.proxy;
  const pooledProxy = getProxyPoolCredentialProxy(input.proxyPoolId);
  if (pooledProxy?.enabled) return pooledProxy;
  if (input.tenantProxy?.enabled) return input.tenantProxy;
  return input.useGlobalProxy ? getGlobalProxySetting() : null;
}
