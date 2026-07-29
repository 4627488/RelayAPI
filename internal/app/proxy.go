package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
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

func requestMetadata(body []byte, r *http.Request) requestMeta {
	meta := readRequestMeta(body, r.URL.Path)
	if meta.Model == "" {
		meta.Model = strings.TrimSpace(r.URL.Query().Get("model"))
	}
	if isWebSocketUpgrade(r) {
		meta.Stream = true
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
	meta := requestMetadata(body, r)
	websocket := isWebSocketUpgrade(r)
	billable := meta.Model != "" && (websocket || (r.Method != http.MethodGet && r.Method != http.MethodHead))
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
	admission := store.Admission{RequestID: requestID}
	if billable {
		price, err = a.store.Price(r.Context(), meta.Model)
		if err != nil {
			if a.cfg.UnpricedModelPolicy == "deny" {
				writeError(w, http.StatusBadRequest, "price_not_configured", "模型尚未配置价格")
				return
			}
		} else {
			priceConfigured = true
		}
		priceSnapshot, _ := json.Marshal(price)
		reserve := int64(0)
		if priceConfigured {
			reserve = a.cfg.ReservationNanoUSD
		}
		reservationTTL := maxDuration(30*time.Minute, a.cfg.RequestTimeout+5*time.Minute)
		if websocket {
			reservationTTL = 24 * time.Hour
		}
		admission, err = a.store.AdmitRequest(r.Context(), store.AdmissionInput{
			RequestID: requestID, Key: key, Model: meta.Model,
			BalanceReserve: reserve, QuotaReserve: reserve, PriceConfigured: priceConfigured,
			PriceSnapshot: priceSnapshot, ExpiresAt: time.Now().Add(reservationTTL),
		})
		if err != nil {
			switch {
			case errors.Is(err, store.ErrSubscriptionPrice):
				writeError(w, http.StatusBadRequest, "price_not_configured", "计量子订阅要求先配置模型价格")
			case errors.Is(err, store.ErrSubscriptionRequired):
				writeError(w, http.StatusForbidden, "subscription_not_available", "没有可用于该模型的子订阅")
			case errors.Is(err, store.ErrSubscriptionExhausted):
				writeError(w, http.StatusTooManyRequests, "subscription_quota_exceeded", "所有可用子订阅额度均已耗尽")
			default:
				writeError(w, http.StatusPaymentRequired, "admission_failed", "余额不足或订阅不可用")
			}
			return
		}
		if admission.CPAAuthID != "" && !a.bridgeReady.Load() {
			a.releaseReservation(requestID, true)
			writeError(w, http.StatusServiceUnavailable, "cpa_bridge_required", "严格子订阅路由要求 CPA bridge 0.2.0 或更高版本")
			return
		}
	}

	if websocket {
		r.Body = io.NopCloser(bytes.NewReader(body))
		a.proxyWebSocket(w, r, key, requestID, admission, meta, started, billable)
		return
	}

	target := a.cpa.URL(r.URL.RequestURI())
	upstream, err := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err != nil {
		a.releaseReservation(requestID, billable)
		writeError(w, 500, "proxy_error", err.Error())
		return
	}
	copyHeaders(upstream.Header, r.Header)
	upstream.Header.Set("Authorization", "Bearer "+a.cfg.CPAAPIKey)
	upstream.Header.Del("X-API-Key")
	upstream.Header.Set("X-Relay-Request-ID", requestID)
	if admission.CPAAuthID != "" {
		upstream.Header.Set("X-Relay-CPA-Auth-ID", admission.CPAAuthID)
		setRoutingSignature(upstream.Header, requestID, admission.CPAAuthID, a.cfg.CPAPluginSecret, time.Now())
	}
	upstream.Host = a.cpa.BaseURL.Host

	response, err := a.cpa.HTTP.Do(upstream)
	if err != nil {
		a.releaseReservation(requestID, billable)
		a.writeRequestLog(key, requestID, admission, meta, r, 0, started, nil, false, true, 0, err.Error())
		writeError(w, http.StatusBadGateway, "cpa_unavailable", "CPA 暂时不可用")
		return
	}
	defer response.Body.Close()
	copyHeaders(w.Header(), response.Header)
	w.Header().Set("X-Relay-Request-ID", requestID)
	if admission.ChildSubscriptionID != "" {
		w.Header().Set("X-Relay-Subscription-ID", admission.ChildSubscriptionID)
	}
	w.WriteHeader(response.StatusCode)
	capture := &rollingCapture{max: 2 << 20}
	copyErr := copyStreaming(w, io.TeeReader(response.Body, capture))

	parsed := billing.ParseResponse(capture.Bytes())
	actual := int64(0)
	settled := !billable
	var cost *int64
	if billable && response.StatusCode < http.StatusBadRequest && parsed.Found && priceConfigured {
		actual = billing.Cost(price, parsed.Usage)
		cost = &actual
		if err := a.store.SettleRequestReservation(context.WithoutCancel(r.Context()), requestID, actual, true); err == nil {
			settled = true
		} else {
			slog.Error("settle request", "request_id", requestID, "error", err)
		}
	} else if billable && response.StatusCode < http.StatusBadRequest {
		// Missing usage must not become free parent capacity. Conservatively
		// settle the reservation and keep pricing_complete=false for reconciliation.
		actual = max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD)
		if err := a.store.SettleRequestReservation(context.WithoutCancel(r.Context()), requestID, actual, false); err == nil {
			settled = true
		} else {
			slog.Error("settle incomplete request", "request_id", requestID, "error", err)
		}
	} else if billable {
		a.releaseReservation(requestID, true)
		settled = true
	}
	errorMessage := ""
	if copyErr != nil {
		errorMessage = copyErr.Error()
	}
	a.writeRequestLog(key, requestID, admission, meta, r, response.StatusCode, started, &parsed, cost != nil, settled, actual, errorMessage)
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

func (a *App) writeRequestLog(key store.KeyContext, requestID string, admission store.Admission, meta requestMeta, r *http.Request, status int,
	started time.Time, parsed *billing.Result, pricing, settled bool, cost int64, errorMessage string) {
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
		AuthIndex: admission.CPAAuthIndex, ParentSubscriptionID: admission.ParentSubscriptionID,
		ChildSubscriptionID: admission.ChildSubscriptionID,
		Method:              r.Method, Path: r.URL.Path, StatusCode: status, Stream: meta.Stream, Usage: usage,
		CostNanoUSD: costPointer, PricingComplete: pricing, Settled: settled,
		ReservedNanoUSD: max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD), LatencyMS: time.Since(started).Milliseconds(),
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

func (a *App) proxyWebSocket(w http.ResponseWriter, r *http.Request, key store.KeyContext, requestID string,
	admission store.Admission, meta requestMeta, started time.Time, billable bool) {
	proxy := httputil.NewSingleHostReverseProxy(a.cpa.BaseURL)
	statusCode := 0
	proxy.ModifyResponse = func(response *http.Response) error {
		statusCode = response.StatusCode
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		statusCode = http.StatusBadGateway
		slog.Error("websocket proxy", "request_id", requestID, "error", err)
		writeError(w, statusCode, "cpa_unavailable", "CPA 暂时不可用")
	}
	original := proxy.Director
	proxy.Director = func(request *http.Request) {
		original(request)
		stripRelayHeaders(request.Header)
		request.Header.Set("Authorization", "Bearer "+a.cfg.CPAAPIKey)
		request.Header.Del("X-API-Key")
		request.Header.Set("X-Relay-Request-ID", requestID)
		if admission.CPAAuthID != "" {
			request.Header.Set("X-Relay-CPA-Auth-ID", admission.CPAAuthID)
			setRoutingSignature(request.Header, requestID, admission.CPAAuthID, a.cfg.CPAPluginSecret, time.Now())
		}
	}
	w.Header().Set("X-Relay-Request-ID", requestID)
	proxy.ServeHTTP(w, r)
	actual := max64(admission.BalanceReservedNanoUSD, admission.QuotaReservedNanoUSD)
	settled := !billable
	if billable {
		var err error
		if statusCode == http.StatusSwitchingProtocols {
			err = a.store.SettleRequestReservation(context.Background(), requestID, actual, false)
		} else {
			actual = 0
			err = a.store.ReleaseRequestReservation(context.Background(), requestID)
		}
		if err == nil {
			settled = true
		} else {
			slog.Error("settle websocket request", "request_id", requestID, "error", err)
		}
	}
	a.writeRequestLog(key, requestID, admission, meta, r, statusCode, started, nil, false, settled, actual, "")
	a.store.TouchKey(context.WithoutCancel(r.Context()), key.ID)
}

func (a *App) releaseReservation(requestID string, billable bool) {
	if !billable {
		return
	}
	if err := a.store.ReleaseRequestReservation(context.Background(), requestID); err != nil {
		slog.Error("release request reservation", "request_id", requestID, "error", err)
	}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
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
		if hopHeader(name) || strings.HasPrefix(strings.ToLower(name), "x-relay-") {
			continue
		}
		destination.Del(name)
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func stripRelayHeaders(header http.Header) {
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "x-relay-") {
			header.Del(name)
		}
	}
}

func setRoutingSignature(header http.Header, requestID, authID, secret string, now time.Time) {
	timestamp := strconv.FormatInt(now.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(requestID + "\n" + authID + "\n" + timestamp))
	header.Set("X-Relay-Plugin-Timestamp", timestamp)
	header.Set("X-Relay-Plugin-Signature", hex.EncodeToString(mac.Sum(nil)))
}
func hopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}
