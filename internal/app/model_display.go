package app

import (
	"strings"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/heatmap"
	"github.com/4627488/RelayAPI/internal/store"
)

// Display metadata is computed at the API boundary, including for historical
// models no longer published. Original IDs and stored accounting stay intact.
func (a *App) displayModelID(model string) string {
	if strings.ContainsAny(model, "*?[]") {
		return model
	}
	id := a.canonicalModelID(model)
	if id != model && a.nativeRuntime != nil {
		for _, existing := range a.nativeRuntime.Models() {
			if strings.EqualFold(existing, id) {
				return model
			}
		}
	}
	return id
}

func (a *App) annotateLogModel(log *db.RequestLog) {
	log.CanonicalModel = a.displayModelID(firstNonEmptyString(log.ActualModel, log.Model))
	requested := firstNonEmptyString(log.RequestedModel, log.Model)
	log.CanonicalRequestedModel = requested
	if (log.ModelAlias == "" || !strings.EqualFold(log.ModelAlias, requested)) && strings.EqualFold(requested, firstNonEmptyString(log.ActualModel, log.Model)) {
		log.CanonicalRequestedModel = a.displayModelID(requested)
	}
}

func (a *App) logModelPage(page store.LogPage) store.LogPage {
	for i := range page.Items {
		a.annotateLogModel(&page.Items[i])
	}
	return page
}

func (a *App) logModelDetail(item store.LogWithDetail) store.LogWithDetail {
	a.annotateLogModel(&item.Log)
	return item
}

func (a *App) annotateUsageModels(report map[string]any) {
	if models, ok := report["models"].([]store.UsageModelTotal); ok {
		for i := range models {
			models[i].CanonicalModel = a.displayModelID(models[i].Model)
		}
	}
	if observation, ok := report["observability"].(store.UsageObservability); ok {
		for i := range observation.Failures {
			observation.Failures[i].CanonicalModel = a.displayModelID(observation.Failures[i].Model)
		}
		report["observability"] = observation
	}
}

func (a *App) annotateHeatmapModels(report *heatmap.Report) {
	for i := range report.Days {
		report.Days[i].CanonicalModel = a.displayModelID(report.Days[i].Model)
	}
	for i := range report.Models {
		report.Models[i].CanonicalName = a.displayModelID(report.Models[i].Name)
	}
}

// Search is read-only: translate only a verifiable complete author/model ID,
// including historical names, without introducing an inference fallback.
func (a *App) modelLogQuery(query store.LogQuery) store.LogQuery {
	legacy := func(value string) string {
		_, slug, qualified := strings.Cut(value, "/")
		if qualified && strings.EqualFold(a.displayModelID(slug), value) {
			return slug
		}
		return value
	}
	query.Query = legacy(query.Query)
	// Exact model filters need both IDs: canonical requests may already exist.
	query.ModelAlternative = legacy(query.Model)
	if query.ModelAlternative == query.Model {
		query.ModelAlternative = ""
	}
	return query
}
