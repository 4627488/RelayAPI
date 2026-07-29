package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct { uint32_t abi_version; void* host_ctx; cliproxy_host_call_fn call; cliproxy_host_free_fn free_buffer; } cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct { uint32_t abi_version; cliproxy_plugin_call_fn call; cliproxy_plugin_free_fn free_buffer; cliproxy_plugin_shutdown_fn shutdown; } cliproxy_plugin_api;
extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);

static const cliproxy_host_api* stored_host;
static void store_host_api(const cliproxy_host_api* host) { stored_host = host; }
static int call_host_api(const char* method, const uint8_t* request, size_t request_len, cliproxy_buffer* response) {
	if (stored_host == NULL || stored_host->call == NULL) return 1;
	return stored_host->call(stored_host->host_ctx, method, request, request_len, response);
}
static void free_host_buffer(void* ptr, size_t len) {
	if (stored_host != NULL && stored_host->free_buffer != NULL && ptr != NULL) stored_host->free_buffer(ptr, len);
}
*/
import "C"

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"gopkg.in/yaml.v3"
)

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  any             `json:"error,omitempty"`
}
type lifecycleRequest struct {
	ConfigYAML []byte `json:"config_yaml"`
}
type config struct {
	RelayURL         string         `yaml:"relay_url"`
	Secret           string         `yaml:"secret"`
	Delegate         string         `yaml:"delegate"`
	QuotaAdapterMode string         `yaml:"quota_adapters_mode"`
	QuotaAdapters    []quotaAdapter `yaml:"quota_adapters"`
}
type schedulerRequest struct {
	Options struct {
		Headers map[string][]string `json:"Headers"`
	} `json:"Options"`
	Candidates []struct {
		ID string `json:"ID"`
	} `json:"Candidates"`
}

type interceptorPayload struct {
	RequestID       string
	TraceID         string
	SourceFormat    string
	ToFormat        string
	Model           string
	RequestedModel  string
	Stream          bool
	Headers         http.Header
	RequestHeaders  http.Header
	ResponseHeaders http.Header
	Body            []byte
	OriginalRequest []byte
	RequestBody     []byte
	StatusCode      int
	ChunkIndex      int
	Metadata        map[string]any
}

type completionPayload struct {
	RequestID, TraceID, SourceFormat, Model, RequestedModel, Outcome, Error string
	Stream                                                                  bool
	StatusCode                                                              int
	StartedAt, CompletedAt                                                  time.Time
	Metadata                                                                map[string]any
}

type relayLifecycleEvent struct {
	Event          string `json:"event"`
	RelayRequestID string `json:"relay_request_id"`
	Payload        any    `json:"payload"`
}

type managementRequest struct {
	Method  string
	Path    string
	Headers http.Header
	Query   url.Values
	Body    []byte
}

type managementResponse struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
}

var current atomic.Value
var client = &http.Client{Timeout: 5 * time.Second}
var requestCorrelations sync.Map
var lifecycleQueue = make(chan lifecycleJob, 256)

type lifecycleJob struct {
	URL, Secret string
	Event       relayLifecycleEvent
}

func init() {
	go func() {
		for job := range lifecycleQueue {
			postLifecycle(job)
		}
	}()
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	C.store_host_api(host)
	plugin.abi_version = 1
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	raw := []byte(nil)
	if request != nil && requestLen > 0 {
		raw = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	result, err := handle(C.GoString(method), raw)
	if err != nil {
		result, _ = json.Marshal(envelope{OK: false, Error: map[string]string{"code": "plugin_error", "message": err.Error()}})
	}
	writeResponse(response, result)
	if err != nil {
		return 1
	}
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {}

func handle(method string, raw []byte) ([]byte, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		var req lifecycleRequest
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &req); err != nil {
				return nil, err
			}
		}
		cfg := config{Delegate: "round-robin"}
		if len(req.ConfigYAML) > 0 {
			if err := yaml.Unmarshal(req.ConfigYAML, &cfg); err != nil {
				return nil, err
			}
		}
		adapters, err := loadQuotaAdapters(cfg.QuotaAdapterMode, cfg.QuotaAdapters)
		if err != nil {
			return nil, err
		}
		cfg.QuotaAdapters = adapters
		cfg.RelayURL = strings.TrimRight(strings.TrimSpace(cfg.RelayURL), "/")
		if cfg.Delegate != "fill-first" {
			cfg.Delegate = "round-robin"
		}
		current.Store(cfg)
		return ok(map[string]any{
			"schema_version": 2,
			"metadata": map[string]any{"Name": "RelayAPI Bridge", "Version": "0.4.0", "Author": "4627488",
				"GitHubRepository": "https://github.com/4627488/RelayAPI",
				"Logo":             "https://github.com/4627488.png",
				"ConfigFields": []map[string]any{
					{"Name": "relay_url", "Type": "string", "Description": "RelayAPI private service URL"},
					{"Name": "secret", "Type": "string", "Description": "Shared webhook secret", "Sensitive": true},
					{"Name": "delegate", "Type": "enum", "EnumValues": []string{"round-robin", "fill-first"}},
					{"Name": "quota_adapters_mode", "Type": "enum", "EnumValues": []string{"append", "replace", "disabled"}, "Description": "How custom quota adapter manifests combine with the bundled extension pack"},
					{"Name": "quota_adapters", "Type": "array", "Description": "Declarative provider quota adapter manifests"},
				}},
			"capabilities": map[string]bool{
				"usage_plugin": true, "scheduler": true, "management_api": true,
				"request_interceptor": true, "request_lifecycle_plugin": true,
				"response_interceptor": true, "response_stream_interceptor": true,
			},
		})
	case "management.register":
		return ok(map[string]any{"routes": []map[string]any{{
			"Method": "GET", "Path": "/plugins/relayapi-bridge/quota",
			"Description": "Return a normalized, secret-free quota observation for one CPA auth index.",
		}}})
	case "management.handle":
		var req managementRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, fmt.Errorf("decode management request: %w", err)
		}
		result, status, err := probeQuota(strings.TrimSpace(req.Query.Get("auth_index")), loaded().QuotaAdapters, time.Now())
		if err != nil {
			payload, _ := json.Marshal(map[string]any{"error": map[string]string{"code": "quota_probe_failed", "message": err.Error()}})
			return ok(managementResponse{StatusCode: status, Headers: http.Header{"Content-Type": {"application/json; charset=utf-8"}}, Body: payload})
		}
		payload, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		return ok(managementResponse{StatusCode: http.StatusOK, Headers: http.Header{"Content-Type": {"application/json; charset=utf-8"}}, Body: payload})
	case "usage.handle":
		cfg := loaded()
		if cfg.RelayURL == "" || cfg.Secret == "" {
			return ok(map[string]any{})
		}
		req, err := http.NewRequest(http.MethodPost, cfg.RelayURL+"/internal/cpa/usage", bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Relay-Plugin-Secret", cfg.Secret)
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			return nil, errors.New("RelayAPI rejected usage event")
		}
		return ok(map[string]any{})
	case "request.intercept_before", "request.intercept_after":
		var payload interceptorPayload
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, fmt.Errorf("decode request lifecycle: %w", err)
		}
		relayID := firstHTTPHeader(payload.Headers, "X-Relay-Request-ID")
		if relayID != "" && payload.RequestID != "" {
			requestCorrelations.Store(payload.RequestID, relayID)
		}
		payload = boundedInterceptorPayload(payload)
		enqueueLifecycle(method, relayID, payload)
		return ok(map[string]any{})
	case "response.intercept_after":
		var payload interceptorPayload
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, fmt.Errorf("decode response lifecycle: %w", err)
		}
		relayID := correlatedRelayID(payload.RequestID, payload.RequestHeaders)
		payload = boundedInterceptorPayload(payload)
		enqueueLifecycle(method, relayID, payload)
		return ok(map[string]any{})
	case "response.intercept_stream_chunk":
		var payload interceptorPayload
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, fmt.Errorf("decode stream lifecycle: %w", err)
		}
		// The synchronous stream hook is kept deliberately cheap. Header
		// initialization and the first payload chunk are sufficient for TTFT
		// and diagnostic context; completion carries the terminal outcome.
		if payload.ChunkIndex <= 0 {
			relayID := correlatedRelayID(payload.RequestID, payload.RequestHeaders)
			payload = boundedInterceptorPayload(payload)
			enqueueLifecycle(method, relayID, payload)
		}
		return ok(map[string]any{})
	case "request.complete":
		var payload completionPayload
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, fmt.Errorf("decode request completion: %w", err)
		}
		relayID := ""
		if value, ok := requestCorrelations.LoadAndDelete(payload.RequestID); ok {
			relayID, _ = value.(string)
		}
		enqueueLifecycle(method, relayID, payload)
		return ok(map[string]any{})
	case "scheduler.pick":
		var req schedulerRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		wanted := firstHeader(req.Options.Headers, "X-Relay-CPA-Auth-ID")
		if wanted != "" {
			cfg := loaded()
			if !validRoutingSignature(cfg.Secret, req.Options.Headers, wanted, time.Now()) {
				return nil, errors.New("unauthenticated Relay AuthID routing request")
			}
			for _, candidate := range req.Candidates {
				if candidate.ID == wanted {
					return ok(map[string]any{"AuthID": wanted, "Handled": true})
				}
			}
			return nil, fmt.Errorf("requested Relay AuthID %q is not an eligible CPA candidate", wanted)
		}
		return ok(map[string]any{"DelegateBuiltin": loaded().Delegate, "Handled": true})
	default:
		return ok(map[string]any{})
	}
}

func enqueueLifecycle(event, relayID string, payload any) {
	cfg := loaded()
	if cfg.RelayURL == "" || cfg.Secret == "" || strings.TrimSpace(relayID) == "" {
		return
	}
	job := lifecycleJob{
		URL: cfg.RelayURL, Secret: cfg.Secret,
		Event: relayLifecycleEvent{Event: event, RelayRequestID: relayID, Payload: payload},
	}
	select {
	case lifecycleQueue <- job:
	default:
		// Observability must never stall model traffic.
	}
}

func postLifecycle(job lifecycleJob) {
	raw, err := json.Marshal(job.Event)
	if err != nil {
		return
	}
	for attempt := 0; attempt < 3; attempt++ {
		req, requestErr := http.NewRequest(http.MethodPost, job.URL+"/internal/cpa/lifecycle", bytes.NewReader(raw))
		if requestErr != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Relay-Plugin-Secret", job.Secret)
		response, requestErr := client.Do(req)
		if requestErr == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusNoContent {
				return
			}
		}
		if attempt < 2 {
			time.Sleep(time.Duration(100*(1<<attempt)) * time.Millisecond)
		}
	}
}

func correlatedRelayID(requestID string, headers http.Header) string {
	if relayID := firstHTTPHeader(headers, "X-Relay-Request-ID"); relayID != "" {
		if requestID != "" {
			requestCorrelations.Store(requestID, relayID)
		}
		return relayID
	}
	if value, ok := requestCorrelations.Load(requestID); ok {
		relayID, _ := value.(string)
		return relayID
	}
	return ""
}

func firstHTTPHeader(headers http.Header, name string) string {
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
	}
	return ""
}

func boundedInterceptorPayload(payload interceptorPayload) interceptorPayload {
	payload.Body = boundedBytes(payload.Body, 512<<10)
	payload.OriginalRequest = boundedBytes(payload.OriginalRequest, 512<<10)
	payload.RequestBody = boundedBytes(payload.RequestBody, 512<<10)
	return payload
}

func boundedBytes(value []byte, limit int) []byte {
	if len(value) <= limit {
		return value
	}
	return append([]byte(nil), value[:limit]...)
}

func validRoutingSignature(secret string, headers map[string][]string, authID string, now time.Time) bool {
	requestID := firstHeader(headers, "X-Relay-Request-ID")
	timestamp := firstHeader(headers, "X-Relay-Plugin-Timestamp")
	provided, err := hex.DecodeString(firstHeader(headers, "X-Relay-Plugin-Signature"))
	if secret == "" || requestID == "" || err != nil {
		return false
	}
	unix, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || now.Sub(time.Unix(unix, 0)) > 5*time.Minute || time.Unix(unix, 0).Sub(now) > time.Minute {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(requestID + "\n" + authID + "\n" + timestamp))
	return hmac.Equal(provided, mac.Sum(nil))
}

func firstHeader(headers map[string][]string, name string) string {
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
	}
	return ""
}
func loaded() config {
	if value, ok := current.Load().(config); ok {
		return value
	}
	adapters, _ := loadQuotaAdapters("append", nil)
	return config{Delegate: "round-robin", QuotaAdapters: adapters}
}
func ok(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}
func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}

func callHost(method string, payload any) (json.RawMessage, error) {
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal host callback %s: %w", method, err)
	}
	cMethod := C.CString(method)
	defer C.free(unsafe.Pointer(cMethod))
	var response C.cliproxy_buffer
	var requestPtr *C.uint8_t
	if len(rawPayload) > 0 {
		allocated := C.CBytes(rawPayload)
		if allocated == nil {
			return nil, fmt.Errorf("allocate host callback %s", method)
		}
		defer C.free(allocated)
		requestPtr = (*C.uint8_t)(allocated)
	}
	callCode := C.call_host_api(cMethod, requestPtr, C.size_t(len(rawPayload)), &response)
	var rawResponse []byte
	if response.ptr != nil && response.len > 0 {
		rawResponse = C.GoBytes(response.ptr, C.int(response.len))
	}
	if response.ptr != nil {
		C.free_host_buffer(response.ptr, response.len)
	}
	if len(rawResponse) == 0 {
		return nil, fmt.Errorf("host callback %s returned no response, code=%d", method, int(callCode))
	}
	var env envelope
	if err := json.Unmarshal(rawResponse, &env); err != nil {
		return nil, fmt.Errorf("decode host callback %s: %w", method, err)
	}
	if !env.OK {
		return nil, fmt.Errorf("host callback %s failed", method)
	}
	return env.Result, nil
}
