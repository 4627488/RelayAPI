import "server-only";

import { calculateRequestCost } from "@/src/server/services/modelPricing";
import { recordCredentialPricedUsage } from "@/src/server/services/quotaCalibration";
import { resolveConfiguredModelPrice } from "@/src/server/services/quotaAdministration";
import {
  admitTenantRequest,
  releaseTenantRequest,
  settleTenantRequest,
  tenantQuotaHeaders,
  type TenantQuotaAdmission,
} from "@/src/server/services/tenantQuota";
import type { RelayApiKeyContext, UsageSnapshot } from "@/src/shared/types/entities";

type SecondaryUsage = { model: string; usage: UsageSnapshot };

export function admitRelayQuota(
  apiKey: RelayApiKeyContext,
  model: string,
  credentialId: string,
) {
  if (apiKey.tenantId) {
    return admitTenantRequest({
      tenantId: apiKey.tenantId,
      credentialId,
      requestId: crypto.randomUUID(),
      model,
    });
  }
  return {
    requestId: crypto.randomUUID(),
    tenantId: "",
    subscriptionId: null,
    units: null,
    unitsPerCredential: null,
    price: resolveConfiguredModelPrice(model),
    state: null,
  } satisfies TenantQuotaAdmission;
}

export function settleRelayQuota(
  admission: TenantQuotaAdmission | null | undefined,
  usage: UsageSnapshot,
  credentialId: string,
  secondaryUsage?: SecondaryUsage | null,
) {
  if (!admission) return null;
  const mainCost = applyUsagePrice(usage, admission.price);
  const secondaryCost = secondaryUsage
    ? applyUsagePrice(
        secondaryUsage.usage,
        resolveConfiguredModelPrice(secondaryUsage.model),
      )
    : 0n;
  const pricingComplete = usage.pricingComplete === true &&
    (!secondaryUsage || secondaryUsage.usage.pricingComplete === true);
  const totalCost = mainCost + secondaryCost;
  recordCredentialPricedUsage(credentialId, totalCost, pricingComplete);
  if (!pricingComplete) {
    releaseTenantRequest(admission.requestId);
    return null;
  }
  return admission.state
    ? settleTenantRequest({
        requestId: admission.requestId,
        actualNanoUsd: totalCost,
      })
    : null;
}

export function releaseRelayQuota(
  admission: TenantQuotaAdmission | null | undefined,
) {
  if (admission?.state) releaseTenantRequest(admission.requestId);
  return null;
}

export function quotaResponseHeaders(
  state: ReturnType<typeof settleTenantRequest>,
) {
  return state ? tenantQuotaHeaders(state) : {};
}

function applyUsagePrice(
  usage: UsageSnapshot,
  price: ReturnType<typeof resolveConfiguredModelPrice>,
) {
  if (!price) {
    usage.costNanoUsd = null;
    usage.pricingComplete = false;
    return 0n;
  }
  const cost = calculateRequestCost(price, {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cachedInputTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
  });
  usage.costNanoUsd = String(cost.totalNanoUsd);
  usage.priceModel = price.pricedModel;
  usage.priceVersion = price.version;
  usage.inputNanoUsdPerToken = String(price.inputNanoUsdPerToken);
  usage.outputNanoUsdPerToken = String(price.outputNanoUsdPerToken);
  usage.cachedInputNanoUsdPerToken = String(price.cachedInputNanoUsdPerToken);
  usage.cacheWriteNanoUsdPerToken = String(price.cacheWriteNanoUsdPerToken);
  usage.reasoningNanoUsdPerToken = String(price.reasoningNanoUsdPerToken);
  usage.pricingComplete = true;
  return cost.totalNanoUsd;
}
