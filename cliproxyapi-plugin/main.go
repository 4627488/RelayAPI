package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef struct { uint32_t abi_version; void* host_ctx; void* call; void* free_buffer; } cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct { uint32_t abi_version; cliproxy_plugin_call_fn call; cliproxy_plugin_free_fn free_buffer; cliproxy_plugin_shutdown_fn shutdown; } cliproxy_plugin_api;
extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
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
	RelayURL string `yaml:"relay_url"`
	Secret   string `yaml:"secret"`
	Delegate string `yaml:"delegate"`
}
type schedulerRequest struct {
	Options struct {
		Headers map[string][]string `json:"Headers"`
	} `json:"Options"`
	Candidates []struct {
		ID string `json:"ID"`
	} `json:"Candidates"`
}

var current atomic.Value
var client = &http.Client{Timeout: 5 * time.Second}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(_ *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
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
		cfg.RelayURL = strings.TrimRight(strings.TrimSpace(cfg.RelayURL), "/")
		if cfg.Delegate != "fill-first" {
			cfg.Delegate = "round-robin"
		}
		current.Store(cfg)
		return ok(map[string]any{
			"schema_version": 1,
			"metadata": map[string]any{"Name": "RelayAPI Bridge", "Version": "0.1.0", "Author": "4627488",
				"ConfigFields": []map[string]any{
					{"Name": "relay_url", "Type": "string", "Description": "RelayAPI private service URL"},
					{"Name": "secret", "Type": "string", "Description": "Shared webhook secret", "Sensitive": true},
					{"Name": "delegate", "Type": "enum", "EnumValues": []string{"round-robin", "fill-first"}},
				}},
			"capabilities": map[string]bool{"usage_plugin": true, "scheduler": true},
		})
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
	case "scheduler.pick":
		var req schedulerRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		wanted := firstHeader(req.Options.Headers, "X-Relay-CPA-Auth-ID")
		if wanted != "" {
			for _, candidate := range req.Candidates {
				if candidate.ID == wanted {
					return ok(map[string]any{"AuthID": wanted, "Handled": true})
				}
			}
		}
		return ok(map[string]any{"DelegateBuiltin": loaded().Delegate, "Handled": true})
	default:
		return ok(map[string]any{})
	}
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
	return config{Delegate: "round-robin"}
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
