import "server-only";

import { HttpError } from "@/src/server/http/errors";
import {
  releaseTenantQuota,
  reserveTenantQuota,
  settleTenantQuota,
  TenantQuotaCapacityError,
  type TenantQuotaState,
} from "@/src/server/repositories/quotaAccounting";
import { getTenantById } from "@/src/server/repositories/tenants";
import {
  resolveModelPrice,
  type ModelPriceSnapshot,
} from "@/src/server/services/modelPricing";
import { getEffectiveQuotaBaselines } from "@/src/server/services/quotaCalibration";

export interface TenantQuotaAdmission {
  requestId: string;
  tenantId: string;
  shares: number | null;
  price: ModelPriceSnapshot | null;
  state: TenantQuotaState | null;
}

export function admitTenantRequest(input: {
  tenantId: string;
  requestId: string;
  model: string;
  now?: Date;
}): TenantQuotaAdmission {
  const tenant = getTenantById(input.tenantId);
  if (!tenant) {
    throw new HttpError(404, "tenant_not_found", "Tenant not found");
  }
  const price = resolveModelPrice(input.model);
  if (tenant.quotaShares === null) {
    return {
      requestId: input.requestId,
      tenantId: input.tenantId,
      shares: null,
      price,
      state: null,
    };
  }
  if (!price) {
    throw new HttpError(
      503,
      "model_price_unavailable",
      `No price is configured for model ${input.model}`,
      { model: input.model },
    );
  }
  const baselines = getEffectiveQuotaBaselines();
  if (!baselines["5h"].effectiveNanoUsd || !baselines["7d"].effectiveNanoUsd) {
    throw new HttpError(
      503,
      "quota_baseline_unavailable",
      "Tenant quota baseline has not been calibrated or configured",
    );
  }
  const sharesMilli = BigInt(Math.round(tenant.quotaShares * 1000));
  const limits = {
    "5h": (baselines["5h"].effectiveNanoUsd * sharesMilli) / BigInt(1000),
    "7d": (baselines["7d"].effectiveNanoUsd * sharesMilli) / BigInt(1000),
  };
  const smallestLimit = limits["5h"] < limits["7d"] ? limits["5h"] : limits["7d"];
  const reserveNanoUsd = maxBigInt(
    BigInt(1),
    minBigInt(BigInt(10_000_000), smallestLimit / BigInt(100)),
  );
  const now = input.now || new Date();
  try {
    const state = reserveTenantQuota({
      requestId: input.requestId,
      tenantId: input.tenantId,
      reserveNanoUsd,
      limitsNanoUsd: limits,
      now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    });
    return {
      requestId: input.requestId,
      tenantId: input.tenantId,
      shares: tenant.quotaShares,
      price,
      state,
    };
  } catch (error) {
    if (!(error instanceof TenantQuotaCapacityError)) throw error;
    const remaining = maxBigInt(
      BigInt(0),
      error.state.limitNanoUsd -
        error.state.settledNanoUsd -
        error.state.reservedNanoUsd,
    );
    throw new HttpError(
      429,
      "tenant_quota_exceeded",
      `Tenant ${error.window} quota is exhausted.`,
      {
        type: "rate_limit_error",
        window: error.window,
        limit: String(error.state.limitNanoUsd),
        used: String(error.state.settledNanoUsd + error.state.reservedNanoUsd),
        remaining: String(remaining),
        resets_at: error.state.resetsAt,
        retry_after: Math.max(
          1,
          Math.ceil((Date.parse(error.state.resetsAt) - now.getTime()) / 1000),
        ),
      },
    );
  }
}

export function settleTenantRequest(input: {
  requestId: string;
  actualNanoUsd: bigint;
}) {
  return settleTenantQuota(input);
}

export function releaseTenantRequest(requestId: string) {
  releaseTenantQuota(requestId);
}

export function tenantQuotaHeaders(state: TenantQuotaState, shares: number) {
  const headers: Record<string, string> = {
    "x-relay-quota-shares": String(shares),
  };
  for (const kind of ["5h", "7d"] as const) {
    const window = state.windows[kind];
    const used = window.settledNanoUsd + window.reservedNanoUsd;
    headers[`x-relay-quota-${kind}-limit-nanousd`] = String(window.limitNanoUsd);
    headers[`x-relay-quota-${kind}-used-nanousd`] = String(used);
    headers[`x-relay-quota-${kind}-remaining-nanousd`] = String(
      maxBigInt(BigInt(0), window.limitNanoUsd - used),
    );
    headers[`x-relay-quota-${kind}-reset`] = window.resetsAt;
  }
  return headers;
}

function minBigInt(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function maxBigInt(left: bigint, right: bigint) {
  return left > right ? left : right;
}
