-- Optional rollback, outside a transaction. Never removes request data.
SET lock_timeout = '2s';
SET statement_timeout = '120s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_request_logs_cpa_request_id
ON public.request_logs (upstream_request_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_request_logs_cpa_trace_id
ON public.request_logs (upstream_trace_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_request_logs_cpa_execution_id
ON public.request_logs (upstream_execution_id);
DROP INDEX CONCURRENTLY IF EXISTS public.request_logs_usage_cover_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.request_logs_token_rate_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.request_logs_output_token_rate_idx;
