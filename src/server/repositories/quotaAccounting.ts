import "server-only";

import { and, eq, lt } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import {
  quotaReservations,
  tenantQuotaWindows,
} from "@/src/server/db/schema";

export type QuotaWindowKind = "5h" | "7d";

const WINDOW_MS: Record<QuotaWindowKind, number> = {
  "5h": 5 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export interface TenantQuotaWindowState {
  kind: QuotaWindowKind;
  startedAt: string;
  resetsAt: string;
  limitNanoUsd: bigint;
  settledNanoUsd: bigint;
  reservedNanoUsd: bigint;
}

export interface TenantQuotaState {
  tenantId: string;
  windows: Record<QuotaWindowKind, TenantQuotaWindowState>;
}

export class TenantQuotaCapacityError extends Error {
  constructor(
    readonly window: QuotaWindowKind,
    readonly state: TenantQuotaWindowState,
  ) {
    super(`Tenant ${window} quota has insufficient capacity`);
    this.name = "TenantQuotaCapacityError";
  }
}

export function reserveTenantQuota(input: {
  requestId: string;
  tenantId: string;
  reserveNanoUsd: bigint;
  limitsNanoUsd: Record<QuotaWindowKind, bigint>;
  now?: Date;
  expiresAt: Date;
}) {
  const now = input.now || new Date();
  return getMainOrm().transaction((tx) => {
    reclaimExpired(tx, input.tenantId, now);
    const rows = {} as Record<QuotaWindowKind, TenantQuotaWindowState>;
    for (const kind of ["5h", "7d"] as const) {
      let row = tx
        .select()
        .from(tenantQuotaWindows)
        .where(
          and(
            eq(tenantQuotaWindows.tenantId, input.tenantId),
            eq(tenantQuotaWindows.windowKind, kind),
          ),
        )
        .get();
      if (!row || row.resetsAt <= now.toISOString()) {
        const resetsAt = new Date(now.getTime() + WINDOW_MS[kind]).toISOString();
        tx.insert(tenantQuotaWindows)
          .values({
            tenantId: input.tenantId,
            windowKind: kind,
            startedAt: now.toISOString(),
            resetsAt,
            limitNanoUsd: String(input.limitsNanoUsd[kind]),
            settledNanoUsd: "0",
            reservedNanoUsd: "0",
            updatedAt: now.toISOString(),
          })
          .onConflictDoUpdate({
            target: [tenantQuotaWindows.tenantId, tenantQuotaWindows.windowKind],
            set: {
              startedAt: now.toISOString(),
              resetsAt,
              limitNanoUsd: String(input.limitsNanoUsd[kind]),
              settledNanoUsd: "0",
              reservedNanoUsd: "0",
              updatedAt: now.toISOString(),
            },
          })
          .run();
        row = tx
          .select()
          .from(tenantQuotaWindows)
          .where(
            and(
              eq(tenantQuotaWindows.tenantId, input.tenantId),
              eq(tenantQuotaWindows.windowKind, kind),
            ),
          )
          .get()!;
      }
      const state = toWindowState(row);
      state.limitNanoUsd = input.limitsNanoUsd[kind];
      if (
        state.settledNanoUsd + state.reservedNanoUsd + input.reserveNanoUsd >
        state.limitNanoUsd
      ) {
        throw new TenantQuotaCapacityError(kind, state);
      }
      tx.update(tenantQuotaWindows)
        .set({
          limitNanoUsd: String(state.limitNanoUsd),
          reservedNanoUsd: String(state.reservedNanoUsd + input.reserveNanoUsd),
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(tenantQuotaWindows.tenantId, input.tenantId),
            eq(tenantQuotaWindows.windowKind, kind),
          ),
        )
        .run();
      rows[kind] = {
        ...state,
        reservedNanoUsd: state.reservedNanoUsd + input.reserveNanoUsd,
      };
    }
    tx.insert(quotaReservations)
      .values({
        requestId: input.requestId,
        tenantId: input.tenantId,
        reserveNanoUsd: String(input.reserveNanoUsd),
        status: "active",
        expiresAt: input.expiresAt.toISOString(),
        createdAt: now.toISOString(),
      })
      .run();
    return { tenantId: input.tenantId, windows: rows };
  });
}

export function settleTenantQuota(input: {
  requestId: string;
  actualNanoUsd: bigint;
}) {
  return getMainOrm().transaction((tx) => {
    const reservation = tx
      .select()
      .from(quotaReservations)
      .where(eq(quotaReservations.requestId, input.requestId))
      .get();
    if (!reservation || reservation.status !== "active") {
      return reservation ? readState(tx, reservation.tenantId) : null;
    }
    const reserved = BigInt(reservation.reserveNanoUsd);
    const now = new Date().toISOString();
    for (const kind of ["5h", "7d"] as const) {
      const row = tx
        .select()
        .from(tenantQuotaWindows)
        .where(
          and(
            eq(tenantQuotaWindows.tenantId, reservation.tenantId),
            eq(tenantQuotaWindows.windowKind, kind),
          ),
        )
        .get();
      if (!row) continue;
      tx.update(tenantQuotaWindows)
        .set({
          reservedNanoUsd: String(maxBigInt(0n, BigInt(row.reservedNanoUsd) - reserved)),
          settledNanoUsd: String(BigInt(row.settledNanoUsd) + input.actualNanoUsd),
          updatedAt: now,
        })
        .where(
          and(
            eq(tenantQuotaWindows.tenantId, reservation.tenantId),
            eq(tenantQuotaWindows.windowKind, kind),
          ),
        )
        .run();
    }
    tx.update(quotaReservations)
      .set({ status: "settled", actualNanoUsd: String(input.actualNanoUsd), settledAt: now })
      .where(eq(quotaReservations.requestId, input.requestId))
      .run();
    return readState(tx, reservation.tenantId);
  });
}

export function releaseTenantQuota(requestId: string) {
  return getMainOrm().transaction((tx) => {
    const row = tx.select().from(quotaReservations).where(eq(quotaReservations.requestId, requestId)).get();
    if (!row || row.status !== "active") return;
    releaseReservation(tx, row, "released");
  });
}

export function getTenantQuotaState(tenantId: string) {
  return readState(getMainOrm(), tenantId);
}

export function reclaimExpiredQuotaReservations(now = new Date()) {
  return getMainOrm().transaction((tx) => {
    const rows = tx
      .select()
      .from(quotaReservations)
      .where(
        and(
          eq(quotaReservations.status, "active"),
          lt(quotaReservations.expiresAt, now.toISOString()),
        ),
      )
      .all();
    for (const row of rows) releaseReservation(tx, row, "expired");
    return rows.length;
  });
}

type Transaction = Parameters<Parameters<ReturnType<typeof getMainOrm>["transaction"]>[0]>[0];

function reclaimExpired(tx: Transaction, tenantId: string, now: Date) {
  const expired = tx
    .select()
    .from(quotaReservations)
    .where(
      and(
        eq(quotaReservations.tenantId, tenantId),
        eq(quotaReservations.status, "active"),
        lt(quotaReservations.expiresAt, now.toISOString()),
      ),
    )
    .all();
  for (const row of expired) releaseReservation(tx, row, "expired");
}

function releaseReservation(
  tx: Transaction,
  reservation: typeof quotaReservations.$inferSelect,
  status: "released" | "expired",
) {
  const reserved = BigInt(reservation.reserveNanoUsd);
  for (const kind of ["5h", "7d"] as const) {
    const row = tx
      .select()
      .from(tenantQuotaWindows)
      .where(and(eq(tenantQuotaWindows.tenantId, reservation.tenantId), eq(tenantQuotaWindows.windowKind, kind)))
      .get();
    if (row) {
      tx.update(tenantQuotaWindows)
        .set({ reservedNanoUsd: String(maxBigInt(0n, BigInt(row.reservedNanoUsd) - reserved)) })
        .where(and(eq(tenantQuotaWindows.tenantId, reservation.tenantId), eq(tenantQuotaWindows.windowKind, kind)))
        .run();
    }
  }
  tx.update(quotaReservations)
    .set({ status, settledAt: new Date().toISOString() })
    .where(eq(quotaReservations.requestId, reservation.requestId))
    .run();
}

function readState(tx: Transaction | ReturnType<typeof getMainOrm>, tenantId: string) {
  const rows = tx.select().from(tenantQuotaWindows).where(eq(tenantQuotaWindows.tenantId, tenantId)).all();
  const windows = Object.fromEntries(rows.map((row) => [row.windowKind, toWindowState(row)])) as Record<QuotaWindowKind, TenantQuotaWindowState>;
  return { tenantId, windows };
}

function toWindowState(row: typeof tenantQuotaWindows.$inferSelect): TenantQuotaWindowState {
  return {
    kind: row.windowKind as QuotaWindowKind,
    startedAt: row.startedAt,
    resetsAt: row.resetsAt,
    limitNanoUsd: BigInt(row.limitNanoUsd),
    settledNanoUsd: BigInt(row.settledNanoUsd),
    reservedNanoUsd: BigInt(row.reservedNanoUsd),
  };
}

function maxBigInt(left: bigint, right: bigint) {
  return left > right ? left : right;
}
