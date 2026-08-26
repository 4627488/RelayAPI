package rai

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseModelIDsAcceptsOpenAIAndCodexCatalogs(t *testing.T) {
	openai, err := parseModelIDs([]byte(`{"object":"list","data":[{"id":"b"},{"id":"a"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(openai) != 2 || openai[0] != "a" || openai[1] != "b" {
		t.Fatalf("openai = %#v", openai)
	}
	codex, err := parseModelIDs([]byte(`{"models":[{"slug":"visible"},{"slug":"hidden","visibility":"hide"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(codex) != 1 || codex[0] != "visible" {
		t.Fatalf("codex = %#v", codex)
	}
}

func TestGatewayPrefersSessionThenModels(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/rai.json", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"name":"RelayAPI","kind":"rai.dev/v1","api_base":"","models":"/v1/models","session":"/api/rai/session","adapters":["codex"],"contract_version":"1"}`)
	})
	mux.HandleFunc("GET /api/rai/session", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer relay_test" {
			http.Error(w, "denied", http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"contract_version":"1","name":"RelayAPI","models":["gpt-a","gpt-b"],"default_model":"gpt-a","adapters":["codex","opencode"]}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	gateway := Gateway{HTTP: server.Client()}
	discovery, err := gateway.Discover(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if discovery.APIBase != server.URL {
		t.Fatalf("api_base = %q", discovery.APIBase)
	}
	session, err := gateway.Session(context.Background(), server.URL, "relay_test")
	if err != nil {
		t.Fatal(err)
	}
	if session.DefaultModel != "gpt-a" || len(session.Models) != 2 {
		t.Fatalf("session = %#v", session)
	}
}

func TestGatewayFallsBackToModelsCatalog(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"data":[{"id":"only-model"}]}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	gateway := Gateway{HTTP: server.Client()}
	session, err := gateway.Session(context.Background(), server.URL, "relay_test")
	if err != nil {
		t.Fatal(err)
	}
	if session.DefaultModel != "only-model" {
		t.Fatalf("session = %#v", session)
	}
}
