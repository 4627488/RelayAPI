# Agent Note: Remove renamed duplicate request-log indexes

Status: implemented

## Problem

The native-column rename in [migrations.go](../../../../internal/db/migrations.go) preserved indexes named `idx_request_logs_cpa_*`, while GORM's [RequestLog tags](../../../../internal/db/models.go) created identical `idx_request_logs_upstream_*` indexes. Production inspection on 2026-10-13 confirmed identical keys, operator classes, collations, options and uniqueness for all three pairs. Production consumers query columns, not the old index names; retaining both copies adds write and storage work.

## Decision

Migration 14 keeps the current GORM names and drops the three legacy names. The [online script](../../../../deploy/optimize-request-log-indexes.sql) validates equivalent replacements and uses concurrent index operations. A partial covering index accelerates retained generation report aggregation without introducing a cache or changing financial calculations. The [rollback script](../../../../deploy/rollback-request-log-indexes.sql) recreates old indexes if required.

## Alternatives considered

Keeping legacy names would require changing GORM tags and still cleaning the current duplicates. Dropping every unused index based on `idx_scan=0` was rejected because counters are not evidence of permanent lack of consumers. Caching or rolling up current financial data would introduce freshness and double-counting concerns; an index preserves query semantics.

## Consequences

Request data and retained-report semantics stay unchanged. The report index costs about 28 MB and the completed-token-rate index about 3.8 MB on the assessed dataset; removing duplicates saves about 40 MB, yielding about 8 MB net savings. Online installation should run the concurrent script before restarting a populated deployment; ordinary startup migration creates the same index for new installations. The migration integration test verifies legacy removal and preservation of current indexes.
