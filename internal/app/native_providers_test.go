package app

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestNativeProviderAccountOmitsEmptyDetails(t *testing.T) {
	result := nativeProviderAccount(store.UpstreamCredentialSnapshot{
		ID: "openai-test", Name: "Test", Provider: "openai", Enabled: true,
		Models: []string{"gpt-test"}, Document: []byte(`{"type":"openai"}`), Source: "import",
	})
	for _, key := range []string{"email", "base_url", "auth_kind"} {
		if _, ok := result[key]; ok {
			t.Errorf("empty detail %q should be omitted", key)
		}
	}
}

func TestNativeProviderAccountExposesEditableMetadataWithoutSecrets(t *testing.T) {
	proxyID := "proxy-id"
	result := nativeProviderAccount(store.UpstreamCredentialSnapshot{
		ID: "openai-test", Name: "Test", Provider: "openai", Enabled: true, Source: "api_key", ProxyID: &proxyID,
		Document: []byte(`{"type":"openai","api_key":"secret","websockets":true,"headers":{"X-Tenant":"secret","X-Trace":"trace"}}`),
	})
	if result["proxy_configured"] != true || result["websockets"] != true {
		t.Fatalf("editable metadata = %+v", result)
	}
	names, ok := result["custom_header_names"].([]string)
	if !ok || len(names) != 2 || names[0] != "X-Tenant" || names[1] != "X-Trace" {
		t.Fatalf("custom header names = %#v", result["custom_header_names"])
	}
	encoded, _ := json.Marshal(result)
	if string(encoded) == "" || containsAny(string(encoded), "secret", "user:pass") {
		t.Fatalf("account response leaked credential material: %s", encoded)
	}
}

func TestUpdateNativeCredentialDocumentEditsConnectionSettings(t *testing.T) {
	baseURL, apiKey := "https://new.example/v1", "new-secret"
	websockets := true
	headers := map[string]string{"X-Tenant": "tenant-a"}
	updated, err := updateNativeCredentialDocument(json.RawMessage(`{"type":"openai","api_key":"old-secret","proxy_url":"http://old.test"}`), "api_key", nativeProviderUpdateInput{
		BaseURL: &baseURL, APIKey: &apiKey,
		WebSockets: &websockets, Headers: &headers,
	})
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(updated, &document); err != nil {
		t.Fatal(err)
	}
	if document["base_url"] != baseURL || document["api_key"] != apiKey || document["websockets"] != true {
		t.Fatalf("updated document = %#v", document)
	}
	if got := document["headers"].(map[string]any)["X-Tenant"]; got != "tenant-a" {
		t.Fatalf("headers = %#v", document["headers"])
	}

	if _, ok := document["proxy_url"]; ok {
		t.Fatalf("proxy_url was not cleared: %#v", document)
	}
}

func TestUpdateNativeCredentialDocumentRejectsUnsafeSettings(t *testing.T) {
	changedOAuthBase := "https://unexpected.example/v1"
	for _, test := range []struct {
		document json.RawMessage
		source   string
		input    nativeProviderUpdateInput
	}{
		{document: json.RawMessage(`{"type":"codex","access_token":"secret"}`), source: "oauth", input: nativeProviderUpdateInput{BaseURL: &changedOAuthBase}},
	} {
		if _, err := updateNativeCredentialDocument(test.document, test.source, test.input); err == nil {
			t.Fatalf("unsafe update was accepted: %+v", test.input)
		}
	}
}

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func TestNativeProviderAccountInfersAPIKeyKind(t *testing.T) {
	result := nativeProviderAccount(store.UpstreamCredentialSnapshot{
		ID: "openai-test", Name: "Test", Provider: "openai", Enabled: true,
		Models: []string{"gpt-test"}, Document: []byte(`{"type":"openai","api_key":"secret"}`), Source: "native",
	})
	if got := result["auth_kind"]; got != "api_key" {
		t.Fatalf("auth_kind = %#v, want api_key", got)
	}
}
