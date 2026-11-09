package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

func TestRedactionAndStructuredFields(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(handler(&output, slog.LevelInfo))
	logger.Debug("invisible")
	logger.Error("failed Bearer bearer-secret", "request_id", "req-123", "status", 503,
		"error", errors.New("Get https://user:url-password@example.com/api?key=query-secret: api_key=field-secret sk-key-secret"),
		"access_token", "token-secret", "request_body", "private-body",
		"nested", slog.GroupValue(slog.String("password", "password-secret")),
		"object", map[string]string{"private": "object-secret"})
	raw := output.String()
	for _, secret := range []string{"bearer-secret", "url-password", "query-secret", "field-secret", "sk-key-secret", "token-secret", "private-body", "password-secret", "object-secret", "invisible"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("log contains %q", secret)
		}
	}
	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["request_id"] != "req-123" || event["status"] != float64(503) || event["level"] != "ERROR" {
		t.Fatalf("lost structured fields: %v", event)
	}
	if !strings.Contains(event["error"].(string), "example.com/api") {
		t.Fatal("lost useful error context")
	}
}

func TestFreeTextCredentialForms(t *testing.T) {
	for _, value := range []string{
		`{"access_token":"private-value"}`, `Authorization: Bearer private-value`,
		`password='private-value'`, `Cookie: private-value`, `relay_private-value`,
	} {
		if strings.Contains(clean(value), "private-value") {
			t.Fatalf("credential not removed: %s", value)
		}
	}
}

func TestLegacyFormatterUsesSamePolicy(t *testing.T) {
	raw, err := (legacyFormatter{}).Format(&logrus.Entry{
		Level: logrus.WarnLevel, Message: "refresh failed Bearer legacy-secret",
		Data: logrus.Fields{"credential_id": "credential-1", "refresh_token": "refresh-secret"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatal(err)
	}
	if event["level"] != "WARN" || event["service"] != "relayapi" || event["credential_id"] != "credential-1" || strings.Contains(string(raw), "legacy-secret") || strings.Contains(string(raw), "refresh-secret") {
		t.Fatalf("unexpected legacy log: %s", raw)
	}
}

func TestBoundedText(t *testing.T) {
	value := clean(strings.Repeat("密", 3000))
	if len(value) > 4200 || !strings.HasSuffix(value, "[truncated]") {
		t.Fatal("text was not bounded")
	}
	// Also exercise Handle with an error that contains a newline: one event
	// must occupy one physical line for Docker and Loki.
	var output bytes.Buffer
	record := slog.NewRecord(time.Now(), slog.LevelError, "line one\nline two", 0)
	if err := handler(&output, slog.LevelInfo).Handle(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if bytes.Count(output.Bytes(), []byte("\n")) != 1 {
		t.Fatal("multiline JSON event")
	}
}
