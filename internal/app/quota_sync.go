package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
)

type quotaSyncResult struct {
	ParentID   string    `json:"parent_id"`
	AuthIndex  string    `json:"cpa_auth_index"`
	Provider   string    `json:"provider"`
	Supported  bool      `json:"supported"`
	Status     string    `json:"status"`
	ObservedAt time.Time `json:"observed_at,omitempty"`
	Windows    int       `json:"windows"`
	Error      string    `json:"error,omitempty"`
}

func (a *App) adminSyncParentQuotas(w http.ResponseWriter, r *http.Request) {
	if !a.requireCPAManagement(w) {
		return
	}
	parents, err := a.store.ListParentSubscriptions(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database_error", err.Error())
		return
	}
	results := a.syncParentQuotas(r.Context(), parents)
	writeJSON(w, http.StatusOK, map[string]any{"items": results, "synced": len(results)})
}

func (a *App) adminSyncParentQuota(w http.ResponseWriter, r *http.Request) {
	if !a.requireCPAManagement(w) {
		return
	}
	parent, err := a.store.GetParentSubscription(r.Context(), r.PathValue("id"))
	if err != nil {
		writeSubscriptionError(w, err)
		return
	}
	result := a.syncParentQuota(r.Context(), parent)
	status := http.StatusOK
	if result.Status == "error" {
		status = http.StatusBadGateway
	}
	writeJSON(w, status, result)
}

func (a *App) refreshParentQuotas(ctx context.Context) {
	if strings.TrimSpace(a.cfg.CPAManagementKey) == "" {
		return
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	ready, version, err := a.cpa.QuotaReady(probeCtx)
	cancel()
	if err != nil {
		slog.Warn("check CPA quota extension", "error", err)
		return
	}
	if !ready {
		slog.Debug("skip automatic CPA quota sync", "bridge_version", version, "required", "0.3.0")
		return
	}
	parents, err := a.store.ListParentSubscriptions(ctx)
	if err != nil {
		slog.Error("list parents for automatic quota sync", "error", err)
		return
	}
	eligible := make([]store.ParentSubscription, 0, len(parents))
	for _, parent := range parents {
		if parent.Enabled && !parent.CPAUnavailable && strings.TrimSpace(parent.CPAAuthIndex) != "" {
			eligible = append(eligible, parent)
		}
	}
	for _, result := range a.syncParentQuotas(ctx, eligible) {
		if result.Status == "error" {
			slog.Warn("automatic CPA quota sync", "parent_id", result.ParentID, "provider", result.Provider, "error", result.Error)
		}
	}
}

func (a *App) syncParentQuotas(ctx context.Context, parents []store.ParentSubscription) []quotaSyncResult {
	if len(parents) == 0 {
		return []quotaSyncResult{}
	}
	workerCount := min(4, len(parents))
	jobs := make(chan store.ParentSubscription)
	results := make(chan quotaSyncResult, len(parents))
	var workers sync.WaitGroup
	for range workerCount {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for parent := range jobs {
				results <- a.syncParentQuota(ctx, parent)
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, parent := range parents {
			select {
			case jobs <- parent:
			case <-ctx.Done():
				return
			}
		}
	}()
	workers.Wait()
	close(results)
	items := make([]quotaSyncResult, 0, len(parents))
	for result := range results {
		items = append(items, result)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].AuthIndex < items[j].AuthIndex })
	return items
}

func (a *App) syncParentQuota(ctx context.Context, parent store.ParentSubscription) quotaSyncResult {
	result := quotaSyncResult{ParentID: parent.ID, AuthIndex: parent.CPAAuthIndex, Provider: parent.Provider}
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	report, err := a.cpa.Quota(probeCtx, parent.CPAAuthIndex)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		_ = a.store.UpdateParentQuotaProbe(context.WithoutCancel(ctx), parent.ID, parent.QuotaSupported, "error", result.Error, "", nil, nil)
		return result
	}
	snapshot, err := json.Marshal(report)
	if err != nil {
		result.Status = "error"
		result.Error = fmt.Sprintf("encode normalized quota snapshot: %v", err)
		_ = a.store.UpdateParentQuotaProbe(context.WithoutCancel(ctx), parent.ID, parent.QuotaSupported, "error", result.Error, "", nil, nil)
		return result
	}
	result.Provider = firstNonEmptyString(report.Provider, parent.Provider)
	result.Supported = report.Supported
	result.ObservedAt = report.Observed
	if !report.Supported {
		result.Status = "unsupported"
		if err := a.store.UpdateParentQuotaProbe(ctx, parent.ID, false, result.Status, "", report.PlanType, &report.Observed, snapshot); err != nil {
			result.Status, result.Error = "error", err.Error()
		}
		return result
	}

	observationErrors := make([]string, 0)
	for _, window := range report.Windows {
		if !window.Enforceable || window.UsedPercent == nil || window.ResetsAt == nil || strings.TrimSpace(window.Kind) == "" {
			continue
		}
		if !window.ResetsAt.After(report.Observed) {
			continue
		}
		if _, err := a.store.RecordParentQuotaObservation(ctx, parent.ID, window.Kind, *window.UsedPercent, *window.ResetsAt, report.Observed); err != nil {
			observationErrors = append(observationErrors, fmt.Sprintf("%s: %v", window.Kind, err))
			continue
		}
		result.Windows++
	}
	result.Status = "supported"
	if len(observationErrors) > 0 {
		result.Status = "error"
		result.Error = strings.Join(observationErrors, "; ")
	}
	if err := a.store.UpdateParentQuotaProbe(ctx, parent.ID, true, result.Status, result.Error, report.PlanType, &report.Observed, snapshot); err != nil {
		result.Status, result.Error = "error", err.Error()
	}
	return result
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
