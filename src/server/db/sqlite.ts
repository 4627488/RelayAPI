import "server-only";

import Database, {
  type Database as BetterSqliteDatabase,
  type RunResult,
  type Statement,
} from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { serverConfig } from "@/src/server/config/env";
import { logSchema, mainSchema } from "@/src/server/db/schema";
import { migrateMainDb } from "@/src/server/db/migrations/mainMigrations";
import { migrateLogDb } from "@/src/server/db/migrations/logMigrations";
import {
  DEFAULT_TIME_ZONE,
  instantToDateKey,
  isValidTimeZone,
} from "@/src/shared/time";

type SqliteStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
};

export type SqliteDatabase = {
  client: BetterSqliteDatabase;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};

let sqliteTimeZone = DEFAULT_TIME_ZONE;

let mainDb: SqliteDatabase | null = null;
let logDb: SqliteDatabase | null = null;
let mainOrm: BetterSQLite3Database<typeof mainSchema> | null = null;
let logOrm: BetterSQLite3Database<typeof logSchema> | null = null;
let initialized = false;

export function getMainOrm() {
  ensureInitialized();
  if (!mainOrm) {
    throw new Error("Main ORM is not initialized");
  }
  return mainOrm;
}

export function getLogOrm() {
  ensureInitialized();
  if (!logOrm) {
    throw new Error("Log ORM is not initialized");
  }
  return logOrm;
}

export function getMainClient() {
  ensureInitialized();
  if (!mainDb) throw new Error("Main database is not initialized");
  return mainDb.client;
}

export function getLogClient() {
  ensureInitialized();
  if (!logDb) throw new Error("Log database is not initialized");
  return logDb.client;
}

export function ensureInitialized() {
  if (initialized) {
    return;
  }
  fs.mkdirSync(serverConfig.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(serverConfig.mainDbPath), { recursive: true });
  fs.mkdirSync(path.dirname(serverConfig.logDbPath), { recursive: true });

  mainDb = openDatabase(serverConfig.mainDbPath, true);
  logDb = openDatabase(serverConfig.logDbPath, true);
  migrateMainDb(mainDb);
  const storedTimeZone = mainDb
    .prepare("SELECT value FROM settings WHERE key = 'time_zone'")
    .get() as { value?: string } | undefined;
  sqliteTimeZone = isValidTimeZone(storedTimeZone?.value)
    ? storedTimeZone.value
    : DEFAULT_TIME_ZONE;
  logDb.client.function("relay_date_key", (value: unknown) =>
    instantToDateKey(String(value || ""), sqliteTimeZone),
  );
  migrateLogDb(logDb);
  mainOrm = drizzle(mainDb.client, { schema: mainSchema });
  logOrm = drizzle(logDb.client, { schema: logSchema });
  initialized = true;
}

function openDatabase(filePath: string, foreignKeys: boolean) {
  const db = openSqliteDatabase(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${serverConfig.sqliteBusyTimeoutMs}`);
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  return db;
}

function openSqliteDatabase(filePath: string): SqliteDatabase {
  const database = new Database(filePath, {
    timeout: serverConfig.sqliteBusyTimeoutMs,
  });
  return {
    client: database,
    exec: (sql) => database.exec(sql),
    prepare: (sql) => database.prepare(sql) as Statement,
  };
}

export function setSqliteTimeZone(timeZone: string) {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError("A valid IANA timezone is required");
  }
  sqliteTimeZone = timeZone;
}

