-- Run with psql -v ON_ERROR_STOP=1 outside a transaction.
-- Build the replacement before removing exact legacy duplicates.
SET lock_timeout = '2s';
SET statement_timeout = '120s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS request_logs_usage_cover_idx
ON public.request_logs (started_at)
INCLUDE (tenant_id, model, parent_subscription_id, log_unit, status_code, error_code,
         prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens,
         reasoning_tokens, image_input_tokens, cached_image_input_tokens,
         image_output_tokens, total_tokens, cost_nano_usd, provider,
         latency_ms, first_token_ms, ttftms, pricing_complete, settled)
WHERE log_unit NOT IN ('prewarm', 'connection');

CREATE INDEX CONCURRENTLY IF NOT EXISTS request_logs_token_rate_idx
ON public.request_logs (completed_at) INCLUDE (total_tokens)
WHERE log_unit NOT IN ('prewarm', 'connection');

-- Refuse to remove a legacy index if its replacement differs or is invalid.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_index
        WHERE indexrelid = 'public.request_logs_usage_cover_idx'::regclass AND indisvalid
    ) THEN
        RAISE EXCEPTION 'Usage index is invalid; repair it before retrying';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class a
        JOIN pg_index ia ON ia.indexrelid = a.oid
        LEFT JOIN pg_class b ON b.relname = replace(a.relname, '_cpa_', '_upstream_')
                            AND b.relnamespace = a.relnamespace
        LEFT JOIN pg_index ib ON ib.indexrelid = b.oid AND ib.indrelid = ia.indrelid
        WHERE a.oid IN (to_regclass('public.idx_request_logs_cpa_request_id'),
                        to_regclass('public.idx_request_logs_cpa_trace_id'),
                        to_regclass('public.idx_request_logs_cpa_execution_id'))
          AND (ib.indexrelid IS NULL OR NOT ib.indisvalid
               OR ia.indkey <> ib.indkey OR ia.indclass <> ib.indclass
               OR ia.indcollation <> ib.indcollation OR ia.indoption <> ib.indoption
               OR ia.indisunique <> ib.indisunique
               OR ia.indpred IS DISTINCT FROM ib.indpred
               OR ia.indexprs IS DISTINCT FROM ib.indexprs)
    ) THEN
        RAISE EXCEPTION 'Legacy index has no identical valid replacement';
    END IF;
END $$;

-- Keep the current upstream_* indexes required by GORM and drop their old names.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_request_logs_cpa_request_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_request_logs_cpa_trace_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_request_logs_cpa_execution_id;
VACUUM (ANALYZE) public.request_logs;
