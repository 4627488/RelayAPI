package app

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/heatmap"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestLogDisplayPreservesOriginalRouteAndAlias(t *testing.T) {
	a := &App{}
	cost := int64(9007199254740993)
	log := db.RequestLog{Model: "gpt-retired", ActualModel: "gpt-retired", RequestedModel: "gpt-retired", UpstreamModel: "private-upstream", CostNanoUSD: &cost}
	a.annotateLogModel(&log)
	if log.CanonicalModel != "openai/gpt-retired" || log.CanonicalRequestedModel != "openai/gpt-retired" || log.Model != "gpt-retired" || log.ActualModel != "gpt-retired" || log.UpstreamModel != "private-upstream" {
		t.Fatalf("rewrote historical diagnostic fields: %+v", log)
	}
	wire, _ := json.Marshal(log)
	if !strings.Contains(string(wire), `"cost_nano_usd":9007199254740993`) {
		t.Fatal("display projection lost money precision")
	}
	alias := db.RequestLog{Model: "grok-test", ActualModel: "grok-test", RequestedModel: "gpt-mask", ModelAlias: "gpt-mask"}
	a.annotateLogModel(&alias)
	if alias.CanonicalModel != "x-ai/grok-test" || alias.CanonicalRequestedModel != "gpt-mask" {
		t.Fatalf("guessed an author for a custom alias: %+v", alias)
	}
	alias.ModelAlias = ""
	a.annotateLogModel(&alias)
	if alias.CanonicalRequestedModel != "gpt-mask" {
		t.Fatal("legacy alias lost its requested identity")
	}
	collision := modelIDTestApp(t, "gpt-collision", "openai/gpt-collision")
	if collision.displayModelID("gpt-collision") != "gpt-collision" || a.displayModelID("gpt-*") != "gpt-*" || a.displayModelID("unknown") != "unknown" {
		t.Fatal("renamed a conflicting, wildcard or unknown ID")
	}
}

func TestUsageAndHeatmapDisplayKeepAttributionAndTotals(t *testing.T) {
	a := &App{}
	models := []store.UsageModelTotal{{Model: "gpt-retired", Tokens: 55, Cost: 123}}
	failures := []store.UsageFailure{{Model: "grok-retired", Requests: 2}}
	report := map[string]any{"models": models, "observability": store.UsageObservability{Failures: failures}}
	a.annotateUsageModels(report)
	if models[0].CanonicalModel != "openai/gpt-retired" || models[0].Model != "gpt-retired" || models[0].Tokens != 55 || models[0].Cost != 123 || failures[0].CanonicalModel != "x-ai/grok-retired" {
		t.Fatalf("lost attribution: %+v", report)
	}
	h := heatmap.Report{Days: []heatmap.Day{{Model: "gpt-retired", Tokens: 55}}, Models: []heatmap.Model{{Name: "gpt-retired", Tokens: 55}}}
	a.annotateHeatmapModels(&h)
	if h.Days[0].Model != "gpt-retired" || h.Models[0].Name != "gpt-retired" || h.Days[0].CanonicalModel != "openai/gpt-retired" || h.Models[0].CanonicalName != "openai/gpt-retired" {
		t.Fatalf("heatmap changed source attribution: %+v", h)
	}
}

func TestCanonicalLogSearchKeepsBothExactIdentities(t *testing.T) {
	a := &App{}
	query := a.modelLogQuery(store.LogQuery{Query: "openai/gpt-retired", Model: "openai/gpt-retired", TenantID: "tenant"})
	if query.Query != "gpt-retired" || query.Model != "openai/gpt-retired" || query.ModelAlternative != "gpt-retired" || query.TenantID != "tenant" {
		t.Fatalf("search projection: %+v", query)
	}
	unknown := a.modelLogQuery(store.LogQuery{Query: "wrong-author/gpt-retired", Model: "custom/id"})
	if unknown.Query != "wrong-author/gpt-retired" || unknown.ModelAlternative != "" {
		t.Fatalf("blindly stripped unknown namespace: %+v", unknown)
	}
}
