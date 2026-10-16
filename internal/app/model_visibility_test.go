package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestModelMetadataPathsExcludeInferenceActions(t *testing.T) {
	for _, path := range []string{"/v1/models", "/v1/models/fast", "/v1beta/models", "/v1beta/models/gemini", "/v1/models/vendor/model", "/openai/v1/models", "/openai/v1/models/fast", "/backend-api/codex/models", "/backend-api/codex/models/fast"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			if !isNativeModelCatalogRequest(httptest.NewRequest(method, path, nil)) {
				t.Fatalf("metadata path missed: %s %s", method, path)
			}
		}
	}
	for _, path := range []string{"/v1/responses", "/v1beta/models/gemini:generateContent", "/v1beta/models/gemini:countTokens"} {
		if isNativeModelCatalogRequest(httptest.NewRequest(http.MethodGet, path, nil)) {
			t.Fatalf("inference path intercepted: %s", path)
		}
	}
	if isNativeModelCatalogRequest(httptest.NewRequest(http.MethodPost, "/v1/models", nil)) {
		t.Fatal("metadata handler accepted a mutation")
	}
}

func TestClientDiscoveryMatchesTenantEntitlementsAndKeyRestrictions(t *testing.T) {
	now := time.Now()
	grants := []tenantModelGrant{{parent: store.ParentSubscription{Enabled: true, CapacityMode: "unmetered", UpstreamModelAllowlist: []string{"shared", "shared-new"}}, child: store.ChildSubscription{Enabled: true}}}
	catalog := projectTenantModels([]string{"balance", "shared", "shared-new", "private"}, []string{"balance"}, grants, now)
	key := store.KeyContext{TenantModels: []string{"balance"}, SubscriptionModelGrants: []store.SubscriptionModelGrant{{UpstreamModels: []string{"shared", "shared-new"}}}}
	visible := make([]string, 0, len(catalog))
	for _, model := range catalog {
		visible = append(visible, model.ID)
	}
	if got := visibleClientModels(key, []string{"balance", "shared", "shared-new", "private"}); !reflect.DeepEqual(got, visible) {
		t.Fatalf("key discovery %v differs from tenant catalog %v", got, visible)
	}
	key.ModelAllowlist = []string{"shared"}
	if got := visibleClientModels(key, visible); !reflect.DeepEqual(got, []string{"shared"}) {
		t.Fatalf("key allowlist expanded rights: %v", got)
	}
}

func TestCatalogAndModelDetailsApplyKeyPolicyWithoutUpstreamAccess(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{ID: "catalog", Provider: "codex", Enabled: true, Models: []string{"balance", "shared", "private"}, Document: []byte(`{"type":"codex","access_token":"test"}`)})
	key := store.KeyContext{TenantModels: []string{"balance"}, SubscriptionModelGrants: []store.SubscriptionModelGrant{{UpstreamModels: []string{"shared"}}}}
	key.ModelAllowlist = []string{"balance", "shared"}
	key.ModelAliases = []store.APIKeyModelAlias{{Alias: "fast", Model: "shared"}, {Alias: "forbidden-alias", Model: "private"}}
	for _, prefix := range []string{"/v1/models", "/v1beta/models", "/openai/v1/models", "/backend-api/codex/models"} {
		list := httptest.NewRecorder()
		app.serveModelCatalog(list, httptest.NewRequest(http.MethodGet, prefix, nil), key)
		if list.Code != 200 || strings.Contains(list.Body.String(), "private") || strings.Contains(list.Body.String(), "forbidden-alias") {
			t.Fatalf("catalog leaked denied models: %d %s", list.Code, list.Body.String())
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			recorder := httptest.NewRecorder()
			app.serveModelCatalog(recorder, httptest.NewRequest(method, prefix+"/fast?model=private", nil), key)
			if recorder.Code != 200 || recorder.Header().Get("ETag") == "" || recorder.Header().Get("Cache-Control") != "private, no-cache" {
				t.Fatalf("metadata response = %d %s", recorder.Code, recorder.Body.String())
			}
			if method == http.MethodHead {
				if recorder.Body.Len() != 0 {
					t.Fatal("HEAD returned a body")
				}
				continue
			}
			var item map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &item); err != nil {
				t.Fatal(err)
			}
			if catalogModelID(item) != "fast" {
				t.Fatalf("metadata ignored the path alias: %#v", item)
			}
			revoked := key
			revoked.ModelAllowlist = []string{"balance"}
			request := httptest.NewRequest(http.MethodGet, prefix+"/fast", nil)
			request.Header.Set("If-None-Match", recorder.Header().Get("ETag"))
			denied := httptest.NewRecorder()
			app.serveModelCatalog(denied, request, revoked)
			if denied.Code != http.StatusForbidden {
				t.Fatalf("cached metadata bypassed revoked policy: %d", denied.Code)
			}
		}
		for _, model := range []string{"private", "forbidden-alias"} {
			recorder := httptest.NewRecorder()
			new(App).serveModelCatalog(recorder, httptest.NewRequest(http.MethodGet, prefix+"/"+model, nil), key)
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("denied metadata reached unavailable runtime: %s %d", model, recorder.Code)
			}
		}
	}
	unknown := httptest.NewRecorder()
	app.serveModelCatalog(unknown, httptest.NewRequest(http.MethodGet, "/v1/models/not-published", nil), store.KeyContext{})
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown metadata = %d", unknown.Code)
	}
}

func TestDeniedAliasCannotResurrectOrShadowAnAllowedModel(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{ID: "catalog", Provider: "codex", Enabled: true, Models: []string{"allowed", "private"}, Document: []byte(`{"type":"codex","access_token":"test"}`)})
	key := store.KeyContext{TenantModels: []string{"allowed"}}
	key.ModelAliases = []store.APIKeyModelAlias{{Alias: "allowed", Model: "private"}, {Alias: "stale", Model: "private"}}
	if got := app.raiSessionModels(key); len(got) != 0 {
		t.Fatalf("session discovery exposed aliases: %v", got)
	}
	for _, query := range []string{"", "?client_version=0.147.0"} {
		recorder := httptest.NewRecorder()
		app.serveModelCatalog(recorder, httptest.NewRequest(http.MethodGet, "/v1/models"+query, nil), key)
		var document map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
			t.Fatal(err)
		}
		if query == "" {
			if len(document["data"].([]any)) != 0 {
				t.Fatalf("shadowed slug was listed: %s", recorder.Body.String())
			}
		} else {
			for _, raw := range document["models"].([]any) {
				item := raw.(map[string]any)
				if catalogModelID(item) == "stale" || item["visibility"] != "hide" {
					t.Fatalf("denied alias became visible: %#v", item)
				}
			}
		}
	}
}

type observedModelCatalogRuntime struct {
	upstream.Runtime
	observe func(*http.Request)
}

func (runtime observedModelCatalogRuntime) ServeModels(w http.ResponseWriter, r *http.Request) {
	runtime.observe(r)
	runtime.Runtime.ServeModels(w, r)
}

func TestCatalogConditionalsAreEvaluatedAfterKeyFiltering(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{ID: "catalog", Provider: "codex", Enabled: true, Models: []string{"allowed", "private"}, Document: []byte(`{"type":"codex","access_token":"test"}`)})
	app.nativeRuntime = observedModelCatalogRuntime{Runtime: app.nativeRuntime, observe: func(r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
			t.Fatal("unfiltered runtime received client cache conditionals")
		}
	}}
	key := store.KeyContext{TenantModels: []string{"allowed"}}
	first := httptest.NewRecorder()
	app.serveModelCatalog(first, httptest.NewRequest(http.MethodGet, "/v1/models", nil), key)
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("If-None-Match", first.Header().Get("ETag"))
	request.Header.Set("If-Modified-Since", "Thu, 01 Jan 2026 00:00:00 GMT")
	unchanged := httptest.NewRecorder()
	app.serveModelCatalog(unchanged, request, key)
	if unchanged.Code != http.StatusNotModified {
		t.Fatalf("unchanged filtered catalog = %d", unchanged.Code)
	}
	key.TenantModels = []string{"private"}
	changed := httptest.NewRecorder()
	app.serveModelCatalog(changed, request, key)
	if changed.Code != http.StatusOK || changed.Header().Get("ETag") == first.Header().Get("ETag") || strings.Contains(changed.Body.String(), `"id":"allowed"`) {
		t.Fatalf("catalog cache ignored policy change: %d %s", changed.Code, changed.Body.String())
	}
}
