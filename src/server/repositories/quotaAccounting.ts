import "server-only";

import { and, eq, lt } from "drizzle-orm";
import { getMainOrm } from "@/src/server/db/sqlite";
import { quotaReservations, subscriptionQuotaWindows } from "@/src/server/db/schema";

export type QuotaWindowKind = "5h" | "7d";
export interface SubscriptionQuotaWindowState { kind: QuotaWindowKind; startedAt: string; resetsAt: string; limitNanoUsd: bigint; settledNanoUsd: bigint; reservedNanoUsd: bigint; }
export interface SubscriptionQuotaState { subscriptionId: string; windows: Record<QuotaWindowKind, SubscriptionQuotaWindowState>; }
export class SubscriptionQuotaCapacityError extends Error {
  constructor(readonly window: QuotaWindowKind, readonly state: SubscriptionQuotaWindowState) { super(`Subscription ${window} quota has insufficient capacity`); }
}

export function reserveSubscriptionQuota(input: { requestId: string; subscriptionId: string; reserveNanoUsd: bigint; windows: Record<QuotaWindowKind, { limitNanoUsd: bigint; resetsAt: string }>; now?: Date; expiresAt: Date; }) {
  const now = input.now || new Date();
  return getMainOrm().transaction((tx) => {
    reclaimExpired(tx, input.subscriptionId, now);
    const states = {} as Record<QuotaWindowKind, SubscriptionQuotaWindowState>;
    for (const kind of ["5h", "7d"] as const) {
      const desired = input.windows[kind];
      let row = tx.select().from(subscriptionQuotaWindows).where(and(eq(subscriptionQuotaWindows.subscriptionId, input.subscriptionId), eq(subscriptionQuotaWindows.windowKind, kind))).get();
      if (!row || row.resetsAt !== desired.resetsAt) {
        tx.insert(subscriptionQuotaWindows).values({ subscriptionId: input.subscriptionId, windowKind: kind, startedAt: now.toISOString(), resetsAt: desired.resetsAt, limitNanoUsd: String(desired.limitNanoUsd), settledNanoUsd: "0", reservedNanoUsd: "0", updatedAt: now.toISOString() })
          .onConflictDoUpdate({ target: [subscriptionQuotaWindows.subscriptionId, subscriptionQuotaWindows.windowKind], set: { startedAt: now.toISOString(), resetsAt: desired.resetsAt, limitNanoUsd: String(desired.limitNanoUsd), settledNanoUsd: "0", reservedNanoUsd: "0", updatedAt: now.toISOString() } }).run();
        row = tx.select().from(subscriptionQuotaWindows).where(and(eq(subscriptionQuotaWindows.subscriptionId, input.subscriptionId), eq(subscriptionQuotaWindows.windowKind, kind))).get()!;
      }
      const state = { ...toState(row), limitNanoUsd: desired.limitNanoUsd };
      if (state.settledNanoUsd + state.reservedNanoUsd + input.reserveNanoUsd > state.limitNanoUsd) throw new SubscriptionQuotaCapacityError(kind, state);
      tx.update(subscriptionQuotaWindows).set({ limitNanoUsd: String(desired.limitNanoUsd), reservedNanoUsd: String(state.reservedNanoUsd + input.reserveNanoUsd), updatedAt: now.toISOString() }).where(and(eq(subscriptionQuotaWindows.subscriptionId, input.subscriptionId), eq(subscriptionQuotaWindows.windowKind, kind))).run();
      states[kind] = { ...state, reservedNanoUsd: state.reservedNanoUsd + input.reserveNanoUsd };
    }
    tx.insert(quotaReservations).values({ requestId: input.requestId, subscriptionId: input.subscriptionId, reserveNanoUsd: String(input.reserveNanoUsd), status: "active", expiresAt: input.expiresAt.toISOString(), createdAt: now.toISOString() }).run();
    return { subscriptionId: input.subscriptionId, windows: states };
  });
}

export function settleSubscriptionQuota(input: { requestId: string; actualNanoUsd: bigint }) {
  return getMainOrm().transaction((tx) => {
    const reservation = tx.select().from(quotaReservations).where(eq(quotaReservations.requestId, input.requestId)).get();
    if (!reservation || reservation.status !== "active") return reservation ? readState(tx, reservation.subscriptionId) : null;
    const reserved = BigInt(reservation.reserveNanoUsd); const now = new Date().toISOString();
    for (const kind of ["5h", "7d"] as const) {
      const row = tx.select().from(subscriptionQuotaWindows).where(and(eq(subscriptionQuotaWindows.subscriptionId, reservation.subscriptionId), eq(subscriptionQuotaWindows.windowKind, kind))).get();
      if (row) tx.update(subscriptionQuotaWindows).set({ reservedNanoUsd: String(max(0n, BigInt(row.reservedNanoUsd) - reserved)), settledNanoUsd: String(BigInt(row.settledNanoUsd) + input.actualNanoUsd), updatedAt: now }).where(and(eq(subscriptionQuotaWindows.subscriptionId, reservation.subscriptionId), eq(subscriptionQuotaWindows.windowKind, kind))).run();
    }
    tx.update(quotaReservations).set({ status: "settled", actualNanoUsd: String(input.actualNanoUsd), settledAt: now }).where(eq(quotaReservations.requestId, input.requestId)).run();
    return readState(tx, reservation.subscriptionId);
  });
}
export function releaseSubscriptionQuota(requestId: string) { return getMainOrm().transaction((tx) => { const row = tx.select().from(quotaReservations).where(eq(quotaReservations.requestId, requestId)).get(); if (row?.status === "active") release(tx, row, "released"); }); }
export function getSubscriptionQuotaState(subscriptionId: string) { return readState(getMainOrm(), subscriptionId); }
export function calibrateSubscriptionQuota(subscriptionId: string, values: Record<QuotaWindowKind, { startedAt: string; settledNanoUsd: bigint }>) {
  return getMainOrm().transaction((tx) => {
    const now = new Date().toISOString();
    for (const kind of ["5h", "7d"] as const) {
      const result = tx.update(subscriptionQuotaWindows).set({ startedAt: values[kind].startedAt, settledNanoUsd: String(values[kind].settledNanoUsd), updatedAt: now }).where(and(eq(subscriptionQuotaWindows.subscriptionId, subscriptionId), eq(subscriptionQuotaWindows.windowKind, kind))).run();
      if (!result.changes) throw new Error(`Subscription ${kind} quota window has not been initialized`);
    }
    return readState(tx, subscriptionId);
  });
}
export function reclaimExpiredQuotaReservations(now = new Date()) { return getMainOrm().transaction((tx) => { const rows = tx.select().from(quotaReservations).where(and(eq(quotaReservations.status, "active"), lt(quotaReservations.expiresAt, now.toISOString()))).all(); for (const row of rows) release(tx, row, "expired"); return rows.length; }); }

type Tx = Parameters<Parameters<ReturnType<typeof getMainOrm>["transaction"]>[0]>[0];
function reclaimExpired(tx: Tx, subscriptionId: string, now: Date) { for (const row of tx.select().from(quotaReservations).where(and(eq(quotaReservations.subscriptionId, subscriptionId), eq(quotaReservations.status, "active"), lt(quotaReservations.expiresAt, now.toISOString()))).all()) release(tx, row, "expired"); }
function release(tx: Tx, reservation: typeof quotaReservations.$inferSelect, status: "released" | "expired") { const reserved = BigInt(reservation.reserveNanoUsd); for (const kind of ["5h", "7d"] as const) { const row = tx.select().from(subscriptionQuotaWindows).where(and(eq(subscriptionQuotaWindows.subscriptionId, reservation.subscriptionId), eq(subscriptionQuotaWindows.windowKind, kind))).get(); if (row) tx.update(subscriptionQuotaWindows).set({ reservedNanoUsd: String(max(0n, BigInt(row.reservedNanoUsd) - reserved)) }).where(and(eq(subscriptionQuotaWindows.subscriptionId, reservation.subscriptionId), eq(subscriptionQuotaWindows.windowKind, kind))).run(); } tx.update(quotaReservations).set({ status, settledAt: new Date().toISOString() }).where(eq(quotaReservations.requestId, reservation.requestId)).run(); }
function readState(tx: Tx | ReturnType<typeof getMainOrm>, subscriptionId: string) { const rows = tx.select().from(subscriptionQuotaWindows).where(eq(subscriptionQuotaWindows.subscriptionId, subscriptionId)).all(); return { subscriptionId, windows: Object.fromEntries(rows.map((row) => [row.windowKind, toState(row)])) as Record<QuotaWindowKind, SubscriptionQuotaWindowState> }; }
function toState(row: typeof subscriptionQuotaWindows.$inferSelect): SubscriptionQuotaWindowState { return { kind: row.windowKind as QuotaWindowKind, startedAt: row.startedAt, resetsAt: row.resetsAt, limitNanoUsd: BigInt(row.limitNanoUsd), settledNanoUsd: BigInt(row.settledNanoUsd), reservedNanoUsd: BigInt(row.reservedNanoUsd) }; }
function max(a: bigint, b: bigint) { return a > b ? a : b; }
