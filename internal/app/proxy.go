package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/4627488/RelayAPI/internal/billing"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
)

type requestMeta struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
}

func readRequestMeta(body []byte, requestPath string) requestMeta {
	var meta requestMeta
	_ = json.Unmarshal(body, &meta)
	if meta.Model != "" {
		return meta
	}
	// Gemini's native API puts the model in
	// /v1beta/models/{model}:generateContent instead of the JSON body.
	const marker = "/models/"
	if index := strings.Index(requestPath, marker); index >= 0 {
		value := requestPath[index+len(marker):]
		if end := strings.IndexAny(value, ":/"); end >= 0 {
			value = value[:end]
		}
		meta.Model, _ = url.PathUnescape(value)
	}
	return meta
}

type rollingCapture struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (c *rollingCapture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(p) >= c.max {
		c.buf = append(c.buf[:0], p[len(p)-c.max:]...)
	} else {
		overflow := len(c.buf) + len(p) - c.max
		if overflow > 0 {
			c.buf = append(c.buf[:0], c.buf[overflow:]...)
		}
		c.buf = append(c.buf, p...)
	}
	return len(p), nil
}
func (c *rollingCapture) Bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.buf...)
}

func (a *App) proxy(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	keyValue := bearer(r)
	key, err := a.store.ResolveKey(r.Context(), keyValue)
	if err != nil || !key.Enabled || !key.TenantEnabled || expired(key.ExpiresAt) || expired(key.TenantExpiresAt) {
		writeError(w, http.StatusUnauthorized, "invalid_api_key", "API Key 无效或已停用")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<20))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "请求体超过 64 MiB")
		return
	}
	meta := readRequestMeta(body, r.URL.Path)
	billable := r.Method != http.MethodGet && r.Method != http.MethodHead && meta.Model != ""
	if meta.Model != "" && !allowed(meta.Model, key.ModelAllowlist, key.TenantModels) {
		writeError(w, http.StatusForbidden, "model_not_allowed", "该 API Key 无权使用此模型")
		return
	}
	if err := a.enforceLimits(r.Context(), key); err != nil {
		writeError(w, http.StatusTooManyRequests, "quota_exceeded", err.Error())
		return
	}

	var price store.Price
	priceConfigured := false
	requestID := identity.NewID()
	reserved := int64(0)
	if billable {
		price, err = a.store.Price(r.Context(), meta.Model)
		if err != nil {
			if a.cfg.UnpricedModelPolicy == "deny" {
				writeError(w, http.StatusBadRequest, "price_not_configured", "模型尚未配置价格")
				return
			}
		} else {
			priceConfigured = true
			reserved = a.cfg.ReservationNanoUSD
			if err = a.store.Reserve(r.Context(), key.TenantID, requestID, reserved); err != nil {
				writeError(w, http.StatusPaymentRequired, "insufficient_balance", "余额不足")
				return
			}
		}
	}

	if isWebSocketUpgrade(r) {
		a.proxyWebSocket(w, r, key, requestID)
		return
	}

	target := a.cpa.URL(r.URL.RequestURI())
	upstream, err := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err != nil {
		a.refund(requestID, key.TenantID, reserved)
		writeError(w, 500, "proxy_error", err.Error())
		return
	}
	copyHeaders(upstream.Header, r.Header)
	upstream.Header.Set("Authorization", "Bearer "+a.cfg.CPAAPIKey)
	upstream.Header.Del("X-API-Key")
	upstream.Header.Set("X-Relay-Request-ID", requestID)
	upstream.Host = a.cpa.BaseURL.Host

	response, err := a.cpa.HTTP.Do(upstream)
	if err != nil {
		a.refund(requestID, key.TenantID, reserved)
		a.writeRequestLog(key, requestID, meta, r, 0, started, nil, false, true, reserved, 0, err.Error())
		writeError(w, http.StatusBadGateway, "cpa_unavailable", "CPA 暂时不可用")
		return
	}
	defer response.Body.Close()
	copyHeaders(w.Header(), response.Header)
	w.Header().Set("X-Relay-Request-ID", requestID)
	w.WriteHeader(response.StatusCode)
	capture := &rollingCapture{max: 2 << 20}
	copyErr := copyStreaming(w, io.TeeReader(response.Body, capture))

	parsed := billing.ParseResponse(capture.Bytes())
	actual := int64(0)
	settled := !billable || !priceConfigured
	var cost *int64
	if billable && parsed.Found && priceConfigured {
		actual = billing.Cost(price, parsed.Usage)
		cost = &actual
		if err := a.store.Settle(context.WithoutCancel(r.Context()), key.TenantID, requestID, reserved, actual); err == nil {
			settled = true
		} else {
			slog.Error("settle request", "request_id", requestID, "error", err)
		}
	} else if billable && priceConfigured {
		// CLIProxyAPI normally emits usage on the terminal JSON/SSE event. If
		// it does not, release the reservation rather than locking tenant
		// funds forever; the incomplete-pricing audit record remains visible.
		a.refund(requestID, key.TenantID, reserved)
		settled = true
	}
	errorMessage := ""
	if copyErr != nil {
		errorMessage = copyErr.Error()
	}
	a.writeRequestLog(key, requestID, meta, r, response.StatusCode, started, &parsed, cost != nil, settled, reserved, actual, errorMessage)
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

func (a *App) writeRequestLog(key store.KeyContext, requestID string, meta requestMeta, r *http.Request, status int,
	started time.Time, parsed *billing.Result, pricing, settled bool, reserved, cost int64, errorMessage string) {
	usage := store.Usage{}
	cpaID := ""
	if parsed != nil {
		usage = parsed.Usage
		cpaID = parsed.RequestID
	}
	var costPointer *int64
	if pricing {
		costPointer = &cost
	}
	err := a.store.WriteLog(context.WithoutCancel(r.Context()), store.LogInput{
		ID: requestID, TenantID: key.TenantID, APIKeyID: key.ID, CPARequestID: cpaID, Model: meta.Model,
		Method: r.Method, Path: r.URL.Path, StatusCode: status, Stream: meta.Stream, Usage: usage,
		CostNanoUSD: costPointer, PricingComplete: pricing, Settled: settled,
		ReservedNanoUSD: reserved, LatencyMS: time.Since(started).Milliseconds(),
		ErrorMessage: errorMessage, StartedAt: started, CompletedAt: time.Now(),
	})
	if err != nil {
		slog.Error("write request log", "request_id", requestID, "error", err)
	}
}

func copyStreaming(w http.ResponseWriter, source io.Reader) error {
	buffer := make([]byte, 32<<10)
	flusher, _ := w.(http.Flusher)
	for {
		n, err := source.Read(buffer)
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return writeErr
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket")
}

func (a *App) proxyWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext, requestID string) {
	proxy := httputil.NewSingleHostReverseProxy(a.cpa.BaseURL)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		slog.Error("websocket proxy", "request_id", requestID, "error", err)
	}
	original := proxy.Director
	proxy.Director = func(request *http.Request) {
		original(request)
		request.Header.Set("Authorization", "Bearer "+a.cfg.CPAAPIKey)
		request.Header.Del("X-API-Key")
		request.Header.Set("X-Relay-Request-ID", requestID)
	}
	w.Header().Set("X-Relay-Request-ID", requestID)
	proxy.ServeHTTP(w, r)
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

func (a *App) refund(requestID, tenantID string, reserved int64) {
	if reserved == 0 {
		return
	}
	if err := a.store.Settle(context.Background(), tenantID, requestID, reserved, 0); err != nil {
		slog.Error("refund request", "request_id", requestID, "error", err)
	}
}

func (a *App) enforceLimits(ctx context.Context, key store.KeyContext) error {
	tenantTokens, keyTokens, err := a.store.DailyTokens(ctx, key.TenantID, key.ID)
	if err != nil {
		return err
	}
	if key.TenantTokenLimit != nil && tenantTokens >= *key.TenantTokenLimit {
		return errors.New("租户今日 Token 额度已用尽")
	}
	if key.TokenLimitDaily != nil && keyTokens >= *key.TokenLimitDaily {
		return errors.New("API Key 今日 Token 额度已用尽")
	}
	// Per-minute admission is intentionally process-local; PostgreSQL remains the source of truth for billing.
	limit := key.RateLimitPerMinute
	if limit == nil {
		limit = key.TenantRateLimit
	}
	if limit != nil && !a.allowRate(key.ID, *limit) {
		return errors.New("每分钟请求次数超限")
	}
	return nil
}

func expired(value *time.Time) bool { return value != nil && !value.After(time.Now()) }

func copyHeaders(destination, source http.Header) {
	for name, values := range source {
		if hopHeader(name) {
			continue
		}
		destination.Del(name)
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}
func hopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}
