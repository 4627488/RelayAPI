package relaybridge

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	"github.com/tidwall/gjson"
)

// UsageResult contains CPA's canonical token totals. Input includes cache reads
// and writes; output includes reasoning. CPA's public SDK does not expose image,
// audio or video modality buckets, so callers must account for that limitation.
type UsageResult struct {
	RequestID, ResponseID, Model, ServiceTier                 string
	InputTokens, OutputTokens, CachedTokens, CacheWriteTokens int64
	ReasoningTokens, TotalTokens                              int64
	Found                                                     bool
	Quality                                                   string
}

const usageDeliveryWait = 750 * time.Millisecond

type executionUsageContextKey struct{}
type relayUsagePlugin struct{}

var registerRelayUsagePlugin sync.Once

func (relayUsagePlugin) HandleUsage(ctx context.Context, record usage.Record) {
	if ctx == nil {
		return
	}
	if scope, ok := ctx.Value(executionUsageContextKey{}).(*executionUsageScope); ok {
		scope.collect(record)
	}
}

type executionUsageScope struct {
	store                           *requestUsageStore
	model, responseID               string
	started                         time.Time
	completed, successful, released bool
	records                         map[string]usage.Record
}

type requestUsageStore struct {
	mu       sync.Mutex
	requests map[string][]*executionUsageScope
	changed  chan struct{}
}

func newRequestUsageStore() *requestUsageStore {
	registerRelayUsagePlugin.Do(func() {
		usage.RegisterNamedPlugin("relay-structured-usage", relayUsagePlugin{})
	})
	return &requestUsageStore{requests: make(map[string][]*executionUsageScope), changed: make(chan struct{})}
}

func (s *requestUsageStore) notifyLocked() { close(s.changed); s.changed = make(chan struct{}) }

func (s *requestUsageStore) begin(requestID, model string) *executionUsageScope {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, scopes := range s.requests {
		kept := scopes[:0]
		for _, scope := range scopes {
			if now.Sub(scope.started) > requestTraceTTL {
				scope.released = true
			} else {
				kept = append(kept, scope)
			}
		}
		if len(kept) == 0 {
			delete(s.requests, id)
		} else {
			s.requests[id] = kept
		}
	}
	scope := &executionUsageScope{store: s, model: strings.TrimSpace(model), started: now, records: make(map[string]usage.Record)}
	s.requests[requestID] = append(s.requests[requestID], scope)
	s.notifyLocked()
	return scope
}

func (s *executionUsageScope) collect(record usage.Record) {
	if s == nil {
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	if s.released {
		return
	}
	// Additional image-model records can share an execution ID with the main
	// record. Keep the model in the key, and never sum duplicate publications.
	key := record.RequestID + "\x00" + record.Model
	if _, exists := s.records[key]; exists {
		return
	}
	// Retain only accounting metadata, never API keys, auth token hashes,
	// response headers or upstream failure bodies from the original record.
	s.records[key] = usage.Record{RequestID: record.RequestID, Model: record.Model,
		ResponseModel: record.ResponseModel, ResponseServiceTier: record.ResponseServiceTier,
		Generate: usage.GenerateFlag(usage.GenerateEnabled(record.Generate)), Failed: record.Failed, Detail: record.Detail}
	s.store.notifyLocked()
}

func (s *executionUsageScope) finish(success bool) {
	if s == nil {
		return
	}
	s.store.mu.Lock()
	if !s.completed {
		s.completed, s.successful = true, success
	}
	s.store.notifyLocked()
	s.store.mu.Unlock()
}

// observeEnvelope binds only response identity; token and tier interpretation
// remain entirely in CPA. Translated Responses streams contain data envelopes.
func (s *executionUsageScope) observeEnvelope(payload []byte) {
	if s == nil {
		return
	}
	envelopes := bytes.Split(payload, []byte{'\n'})
	if gjson.ValidBytes(payload) {
		envelopes = [][]byte{payload}
	}
	for _, line := range envelopes {
		line = bytes.TrimSpace(line)
		line = bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
		if !gjson.ValidBytes(line) {
			continue
		}
		v := gjson.ParseBytes(line)
		id := v.Get("response.id").String()
		if id == "" {
			id = v.Get("id").String()
		}
		if id == "" {
			continue
		}
		s.store.mu.Lock()
		if !s.released && s.responseID == "" {
			s.responseID = id
			s.store.notifyLocked()
		}
		// Terminal identity is available before the downstream consumes the
		// chunk. Settlement must not wait for that consumer to drain/close the
		// stream, and a later client disconnect cannot undo upstream completion.
		if !s.released && !s.completed {
			switch v.Get("type").String() {
			case "response.completed", "response.incomplete", "response.done":
				s.completed, s.successful = true, true
				s.store.notifyLocked()
			case "response.failed":
				s.completed, s.successful = true, false
				s.store.notifyLocked()
			}
		}
		s.store.mu.Unlock()
	}
}

func (s *executionUsageScope) resultLocked() (UsageResult, bool) {
	if !s.completed || !s.successful || s.released {
		return UsageResult{}, false
	}
	mainRecords := 0
	for _, record := range s.records {
		if !record.Failed && thinking.ParseSuffix(strings.TrimSpace(record.Model)).ModelName == thinking.ParseSuffix(s.model).ModelName {
			mainRecords++
		}
	}
	if mainRecords > 1 {
		return UsageResult{Quality: "ambiguous"}, false
	}
	for _, record := range s.records {
		if record.Failed || thinking.ParseSuffix(strings.TrimSpace(record.Model)).ModelName != thinking.ParseSuffix(s.model).ModelName {
			continue
		}
		if !usage.GenerateEnabled(record.Generate) {
			return UsageResult{Quality: "not_generated"}, false
		}
		b := record.Detail.TokenBreakdown
		quality := string(b.Quality)
		valid := b.Valid() && b.Quality == usage.TokenAccountingQualityComplete
		if quality == "" {
			quality = "missing"
		}
		model := strings.TrimSpace(record.ResponseModel)
		if model == "" {
			model = record.Model
		}
		tier := strings.TrimSpace(record.ResponseServiceTier)
		if tier == "" {
			tier = strings.TrimSpace(record.Detail.ResponseServiceTier)
		}
		return UsageResult{RequestID: record.RequestID, ResponseID: s.responseID, Model: model, ServiceTier: tier,
			InputTokens: b.Input.TotalTokens, OutputTokens: b.Output.TotalTokens, CachedTokens: b.Input.CacheReadTokens,
			CacheWriteTokens: b.Input.CacheWriteTokens, ReasoningTokens: b.Output.ReasoningTokens, TotalTokens: b.TotalTokens,
			Found: valid, Quality: quality}, valid
	}
	return UsageResult{}, false
}

// RequestUsage waits briefly for CPA's asynchronous plugin dispatcher. An exact
// response ID isolates WebSocket turns; HTTP callers select the latest success.
// A missing or incomplete record is never interpreted as zero-token usage.
func (r *Runtime) RequestUsage(ctx context.Context, requestID, responseID string) (UsageResult, bool) {
	if r == nil || r.traces == nil || r.traces.usage == nil {
		return UsageResult{}, false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s := r.traces.usage
	timer := time.NewTimer(usageDeliveryWait)
	defer timer.Stop()
	for {
		s.mu.Lock()
		scopes := s.requests[strings.TrimSpace(requestID)]
		var candidate *executionUsageScope
		for i := len(scopes) - 1; i >= 0; i-- {
			scope := scopes[i]
			if responseID != "" {
				if scope.responseID == responseID {
					candidate = scope
					break
				}
			} else if !scope.completed || scope.successful {
				candidate = scope
				break
			}
		}
		if candidate != nil {
			result, found := candidate.resultLocked()
			if found || result.Quality != "" || (candidate.completed && !candidate.successful) {
				s.mu.Unlock()
				return result, found
			}
		}
		changed := s.changed
		s.mu.Unlock()
		if len(scopes) == 0 {
			return UsageResult{}, false
		}
		select {
		case <-changed:
		case <-timer.C:
			return UsageResult{}, false
		case <-ctx.Done():
			return UsageResult{}, false
		}
	}
}

// ReleaseRequestUsage prevents delayed callbacks from resurrecting a settled
// request and releases all usage scopes associated with its HTTP/WS lifetime.
func (r *Runtime) ReleaseRequestUsage(requestID string) {
	if r == nil || r.traces == nil || r.traces.usage == nil {
		return
	}
	s := r.traces.usage
	s.mu.Lock()
	for _, scope := range s.requests[requestID] {
		scope.released = true
	}
	delete(s.requests, requestID)
	s.notifyLocked()
	s.mu.Unlock()
}
