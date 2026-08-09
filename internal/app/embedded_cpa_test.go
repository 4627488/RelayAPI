package app

import (
	"encoding/json"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestBridgeCredentialsDisablesProviderWebSocketsInRelayMode(t *testing.T) {
	rows := []store.UpstreamCredentialSnapshot{{
		ID: "codex", Provider: "codex", Enabled: true,
		Document: json.RawMessage(`{"type":"codex","access_token":"secret","websockets":true}`),
	}}

	credentials := bridgeCredentials(rows, false)
	var document map[string]any
	if len(credentials) != 1 || json.Unmarshal(credentials[0].Document, &document) != nil {
		t.Fatalf("compiled credentials = %#v", credentials)
	}
	if enabled, ok := document["websockets"].(bool); !ok || enabled {
		t.Fatalf("websockets = %#v, want false", document["websockets"])
	}
	var stored map[string]any
	if json.Unmarshal(rows[0].Document, &stored) != nil || stored["websockets"] != true {
		t.Fatalf("stored credential was mutated: %#v", stored)
	}
}

func TestBridgeCredentialsEnablesProviderWebSocketsInRelayMode(t *testing.T) {
	for _, original := range []string{
		`{"type":"xai","api_key":"secret"}`,
		`{"type":"xai","api_key":"secret","websockets":false}`,
	} {
		rows := []store.UpstreamCredentialSnapshot{{
			ID: "xai", Provider: "xai", Enabled: true, Document: json.RawMessage(original),
		}}
		credentials := bridgeCredentials(rows, true)
		var document map[string]any
		if len(credentials) != 1 || json.Unmarshal(credentials[0].Document, &document) != nil || document["websockets"] != true {
			t.Fatalf("compiled credentials = %#v document=%#v", credentials, document)
		}
		if string(rows[0].Document) != original {
			t.Fatalf("stored credential was mutated: %s", rows[0].Document)
		}
	}
}

func TestBridgeCredentialsDoesNotAddWebSocketsToUnsupportedProvider(t *testing.T) {
	rows := []store.UpstreamCredentialSnapshot{{
		ID: "gemini", Provider: "gemini", Enabled: true,
		Document: json.RawMessage(`{"type":"gemini","api_key":"secret"}`),
	}}
	credentials := bridgeCredentials(rows, true)
	var document map[string]any
	if len(credentials) != 1 || json.Unmarshal(credentials[0].Document, &document) != nil {
		t.Fatalf("compiled credentials = %#v", credentials)
	}
	if _, exists := document["websockets"]; exists {
		t.Fatalf("unsupported provider received websocket capability: %#v", document)
	}
}
