package rai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestResourceOutputKeepsLegacyJSONAndSanitizesTables(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rai_at_initial" {
			t.Error("wrong credential")
		}
		switch r.URL.Path {
		case "/api/rai/manage/keys":
			io.WriteString(w, `{"items":[{"id":"key-id","name":"demo\u001b[2J\n\t","enabled":true,"model_allowlist":["a","b"],"rate_limit_per_minute":5,"token_limit_daily":9007199254740993}],"unexpected":"rai_rt_hidden"}`)
		case "/api/rai/manage/devices":
			io.WriteString(w, `{"items":[{"id":"device-id","device_name":"laptop","purpose":"account","enabled":true}]}`)
		default:
			t.Errorf("unexpected path %s", r.URL)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	out := &bytes.Buffer{}
	a := App{Home: t.TempDir(), Stdout: out, Stderr: io.Discard}
	a.defaults()
	saveTestOAuth(t, &a, server.URL, "account", time.Now().Add(time.Hour))
	for _, resource := range []string{"key", "device"} {
		out.Reset()
		a.Args = []string{resource, "list"}
		if err := a.Execute(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "ID") || strings.HasPrefix(out.String(), "{") || strings.ContainsAny(out.String(), "\x1b\t") || strings.Contains(out.String(), "rai_rt_hidden") {
			t.Fatal(out.String())
		}
		if resource == "key" && (!strings.Contains(out.String(), "9007199254740993") || !strings.Contains(out.String(), "a,b")) {
			t.Fatal(out.String())
		}
		if resource == "device" && !strings.Contains(out.String(), "account") {
			t.Fatal("device permission missing")
		}
		var canonical string
		for _, args := range [][]string{{resource, "list", "--json"}, {resource + "s", "list"}} {
			out.Reset()
			a.Args = args
			if err := a.Execute(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !json.Valid(out.Bytes()) {
				t.Fatal(out.String())
			}
			if canonical == "" {
				canonical = out.String()
			} else if canonical != out.String() {
				t.Fatal("legacy JSON contract changed")
			}
		}
	}
}

func TestResourceMutationsRequireExplicitSecretAndConfirmation(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	const id = "11111111-1111-4111-8111-111111111111"
	deletes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			io.WriteString(w, `{"item":{"id":"`+id+`","name":"demo"},"key":"relay_new_secret"}`)
		case http.MethodDelete:
			deletes++
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request %s", r.Method)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	out := &bytes.Buffer{}
	a := App{Home: t.TempDir(), Stdout: out, Stderr: io.Discard}
	a.defaults()
	saveTestOAuth(t, &a, server.URL, "account", time.Now().Add(time.Hour))
	for _, flags := range [][]string{nil, {"--show-secret"}, {"--json"}, {"--json", "--show-secret"}} {
		out.Reset()
		a.Args = append([]string{"key", "create", "--name", "demo"}, flags...)
		if err := a.Execute(context.Background()); err != nil {
			t.Fatal(err)
		}
		show := strings.Contains(strings.Join(flags, " "), "--show-secret")
		if strings.Contains(out.String(), "relay_new_secret") != show {
			t.Fatal("unexpected Key disclosure")
		}
		if strings.Contains(strings.Join(flags, " "), "--json") != json.Valid(out.Bytes()) {
			t.Fatal(out.String())
		}
	}
	for _, resource := range []string{"key", "device"} {
		operation := "delete"
		if resource == "device" {
			operation = "revoke"
		}
		a.Args = []string{resource, operation, id}
		if err := a.Execute(context.Background()); err == nil {
			t.Fatal("mutation succeeded without --yes")
		}
		if deletes != 0 {
			t.Fatal("sent unconfirmed deletion")
		}
	}
	for _, resource := range []string{"key", "device"} {
		operation := "delete"
		if resource == "device" {
			operation = "revoke"
		}
		out.Reset()
		a.Args = []string{resource, operation, id, "--yes"}
		if err := a.Execute(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "Revoked "+resource) {
			t.Fatal(out.String())
		}
	}
	if deletes != 2 {
		t.Fatalf("deletes=%d", deletes)
	}
}

func TestResourceOutputFlagsPreserveLiteralValues(t *testing.T) {
	rest, asJSON, help, err := resourceOutputFlags([]string{"create", "--name", "--json", "--models=--help"})
	if err != nil || asJSON || help || strings.Join(rest, " ") != "create --name --json --models=--help" {
		t.Fatalf("rest=%v json=%v help=%v err=%v", rest, asJSON, help, err)
	}
	_, _, _, err = resourceOutputFlags([]string{"list", "--json=invalid"})
	if err == nil {
		t.Fatal("invalid output flag accepted")
	}
}

func TestModelListJSONReportsEffectiveDefault(t *testing.T) {
	t.Setenv(envDisableKey, "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rai/session" || r.Header.Get("Authorization") != "Bearer rai_at_initial" {
			t.Error("unexpected inference request")
		}
		io.WriteString(w, `{"models":["model-a","model-b"],"default_model":"model-a"}`)
	}))
	defer server.Close()
	out := &bytes.Buffer{}
	a := App{Home: t.TempDir(), Stdout: out, Stderr: io.Discard, Args: []string{"model", "list", "--json"}}
	a.defaults()
	s, p := saveTestOAuth(t, &a, server.URL, "inference", time.Now().Add(time.Hour))
	p.DefaultModel = "model-b"
	if err := s.PutProfile(p); err != nil {
		t.Fatal(err)
	}
	if err := a.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Models  []string `json:"models"`
		Default string   `json:"default_model"`
	}
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Models) != 2 || result.Default != "model-b" {
		t.Fatal(out.String())
	}
	if strings.Contains(out.String(), "rai_at_") || strings.Contains(out.String(), "rai_rt_") {
		t.Fatal("model output leaked credentials")
	}
}
