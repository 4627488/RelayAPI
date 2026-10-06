package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/identity"
)

func TestRealtimeClientSecretBindsIssuingKeyModelAndExpiry(t *testing.T) {
	box, err := identity.NewSecretBox("stable realtime test encryption key")
	if err != nil {
		t.Fatal(err)
	}
	app := &App{setupBox: box}
	expires := time.Now().Add(time.Minute).Unix()
	for _, legacy := range []bool{false, true} {
		secret := map[string]any{"value": "ek_cpa_secret", "expires_at": expires}
		payload := map[string]any{"value": "ek_cpa_secret", "expires_at": expires, "session": map[string]string{"model": "gpt-realtime"}}
		if legacy {
			payload = map[string]any{"id": "session-1", "model": "gpt-realtime", "client_secret": secret}
		}
		raw, _ := json.Marshal(payload)
		wrapped, err := app.wrapRealtimeSecret(raw, realtimeAuthorization{RelayKey: "relay_origin", Model: "gpt-realtime"})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(wrapped), "relay_origin") || strings.Contains(string(wrapped), "ek_cpa_secret") {
			t.Fatal("plaintext issuing key or internal CPA credential escaped")
		}
		var result map[string]any
		_ = json.Unmarshal(wrapped, &result)
		value, _ := result["value"].(string)
		if legacy {
			value = result["client_secret"].(map[string]any)["value"].(string)
			if result["id"] != "session-1" || result["value"] != nil {
				t.Fatalf("legacy envelope corrupted: %s", wrapped)
			}
		}
		authorization, err := app.openRealtimeSecret(value, time.Now())
		if err != nil || authorization.RelayKey != "relay_origin" || authorization.CPAToken != "ek_cpa_secret" || authorization.Model != "gpt-realtime" || authorization.ExpiresAt != expires {
			t.Fatalf("client secret authorization: %+v %v", authorization, err)
		}
		if _, err := app.openRealtimeSecret(value, time.Unix(expires, 0)); err == nil {
			t.Fatal("expired secret accepted")
		}
		bytes := []byte(value)
		bytes[len(realtimeSecretPrefix)+5] ^= 1
		if _, err := app.openRealtimeSecret(string(bytes), time.Now()); err == nil {
			t.Fatal("tampered secret accepted")
		}
	}
	if realtimeSecretCanAccess("/v1/responses") || realtimeSecretCanAccess("/v1/realtime/client_secrets") || !realtimeSecretCanAccess("/v1/realtime/calls") {
		t.Fatal("Realtime client secret endpoint scope widened")
	}
}
