package store

const (
	LogUnitStep       = "step"
	LogUnitPrewarm    = "prewarm"
	LogUnitConnection = "connection"
)

// Generation statistics include legacy session summaries, but never count
// transport probes or runtime prewarm acknowledgements as inference requests.
const generationLogSQL = "request_logs.log_unit NOT IN ('prewarm', 'connection')"
