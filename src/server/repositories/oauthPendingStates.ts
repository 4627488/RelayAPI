import "server-only";

import { and, eq, lte, sql } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import { oauthPendingStates } from "@/src/server/db/schema";

type OAuthPendingStateRow = typeof oauthPendingStates.$inferSelect;

export interface OAuthPendingStateRecord {
  state: string;
  provider: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
}

export function saveOAuthPendingState(input: OAuthPendingStateRecord) {
  pruneExpiredOAuthPendingStates();
  getMainOrm()
    .insert(oauthPendingStates)
    .values(input)
    .onConflictDoUpdate({
      target: oauthPendingStates.state,
      set: {
        provider: input.provider,
        codeVerifier: input.codeVerifier,
        codeChallenge: input.codeChallenge,
        redirectUri: input.redirectUri,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      },
    })
    .run();
}

export function takeOAuthPendingState(
  state: string,
  provider = "codex",
): OAuthPendingStateRecord | null {
  pruneExpiredOAuthPendingStates();
  const row = getMainOrm()
    .select()
    .from(oauthPendingStates)
    .where(
      and(
        eq(oauthPendingStates.state, state),
        sql`lower(${oauthPendingStates.provider}) = lower(${provider})`,
      ),
    )
    .get();
  if (!row) {
    return null;
  }
  getMainOrm()
    .delete(oauthPendingStates)
    .where(eq(oauthPendingStates.state, state))
    .run();
  return toOAuthPendingStateRecord(row);
}

export function pruneExpiredOAuthPendingStates(now = new Date()) {
  getMainOrm()
    .delete(oauthPendingStates)
    .where(lte(oauthPendingStates.expiresAt, now.toISOString()))
    .run();
}

function toOAuthPendingStateRecord(
  row: OAuthPendingStateRow,
): OAuthPendingStateRecord {
  return {
    state: row.state,
    provider: row.provider,
    codeVerifier: row.codeVerifier,
    codeChallenge: row.codeChallenge,
    redirectUri: row.redirectUri,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
