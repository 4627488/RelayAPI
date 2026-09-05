# Agent Note: Serialize `db.Open` schema setup

Status: implemented

## Problem

CI runs `go test ./...`, so packages migrate the shared `relay_test` database at the same time. PostgreSQL then 23505s on `pg_type_typname_nsp_index` during `CREATE TABLE` and on `pg_class_relname_nsp_index` during `CREATE INDEX IF NOT EXISTS`. The GPT-6 PR failed `TestFirstRegisteredUserBecomesAdministrator` and `TestUpsertUpstreamCredentialUpdatesEncryptedDocument` this way; main is usually green only because the race is timing-dependent.

## Decision

`db.Open` takes `pg_advisory_lock(742184201)` on a pinned `sql.Conn` around `prepareNativeSchema`, `AutoMigrate`, and `runMigrations`. Other connections still run the DDL. Unlock happens on that same connection so pooling cannot drop the lock early.

## Alternatives considered

**`go test -p 1`.** Serializes every package and slows CI for a schema-only race.

**One database per package.** More isolation, more CI fixture surface.

**Ignore IF NOT EXISTS races.** They still abort the test.

## Consequences

Parallel packages can still share one Postgres. Truncate-vs-truncate across packages is unchanged.
