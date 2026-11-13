package app

import (
	"encoding/json"
	"slices"
	"testing"
	"time"
)

func TestRAIDefaultModelSettings(t *testing.T) {
	defaults := []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"}
	for _, test := range []struct {
		name, raw string
		want      []string
	}{
		{"legacy", `{}`, defaults},
		{"custom order", `{"rai_default_models":["grok-4.6","custom"]}`, []string{"grok-4.6", "custom"}},
		{"disabled", `{"rai_default_models":[]}`, []string{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := defaultNativeRuntimeSettings()
			if err := json.Unmarshal([]byte(test.raw), &value); err != nil {
				t.Fatal(err)
			}
			normalizeNativeRuntimeSettings(&value, []byte(test.raw), true, "allow")
			if !slices.Equal(value.RAIDefaultModels, test.want) {
				t.Fatalf("models = %v", value.RAIDefaultModels)
			}
			if message := validateNativeRuntimeSettings(value); message != "" {
				t.Fatal(message)
			}
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			reloaded := defaultNativeRuntimeSettings()
			if err := json.Unmarshal(raw, &reloaded); err != nil {
				t.Fatal(err)
			}
			normalizeNativeRuntimeSettings(&reloaded, raw, true, "allow")
			if !slices.Equal(reloaded.RAIDefaultModels, test.want) {
				t.Fatalf("reloaded models = %v", reloaded.RAIDefaultModels)
			}
		})
	}
	for _, models := range [][]string{nil, {""}, {" bad"}, {"a\nb"}, {"duplicate", "duplicate"}} {
		value := defaultNativeRuntimeSettings()
		value.RAIDefaultModels = models
		if validateNativeRuntimeSettings(value) == "" {
			t.Fatalf("accepted invalid candidates %v", models)
		}
	}
}

func TestDefaultNativeRuntimeSettingsExposeOnlyEffectiveControls(t *testing.T) {
	settings := defaultNativeRuntimeSettings()
	if message := validateNativeRuntimeSettings(settings); message != "" {
		t.Fatalf("default settings are invalid: %s", message)
	}
	if settings.RequestTimeoutSeconds != 86400 || settings.MaxRequestMiB != 1024 ||
		settings.RequestBytesInFlightMiB != 8192 || settings.MemoryReclaimThresholdMiB != 8192 {
		t.Fatalf("process bounds = %#v", settings)
	}
	if settings.UnpricedModelPolicy != "allow" || !settings.UpstreamWebSockets {
		t.Fatalf("policy defaults = %#v", settings)
	}
	compiled := runtimeSettings(settings, "direct")
	if compiled.FailureThreshold != 3 || compiled.FailureCooldown != 0 || compiled.ResponseHeaderTimeout != 24*time.Hour {
		t.Fatalf("isolation settings = %#v", compiled)
	}
}

func TestNativeRuntimeSettingsValidation(t *testing.T) {
	tests := []struct {
		name string
		edit func(*nativeRuntimeSettings)
	}{
		{"routing", func(value *nativeRuntimeSettings) { value.RoutingStrategy = "random" }},
		{"threshold", func(value *nativeRuntimeSettings) { value.CredentialFailureThreshold = 0 }},
		{"cooldown", func(value *nativeRuntimeSettings) { value.CredentialCooldownSeconds = -1 }},
		{"cooldown_high", func(value *nativeRuntimeSettings) { value.CredentialCooldownSeconds = 3601 }},
		{"timeout", func(value *nativeRuntimeSettings) { value.RequestTimeoutSeconds = 0 }},
		{"request_body", func(value *nativeRuntimeSettings) { value.MaxRequestMiB = 0 }},
		{"in_flight", func(value *nativeRuntimeSettings) { value.RequestBytesInFlightMiB = 8 }},
		{"reclaim", func(value *nativeRuntimeSettings) { value.MemoryReclaimThresholdMiB = 8 }},
		{"unpriced", func(value *nativeRuntimeSettings) { value.UnpricedModelPolicy = "maybe" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := defaultNativeRuntimeSettings()
			test.edit(&value)
			if validateNativeRuntimeSettings(value) == "" {
				t.Fatalf("invalid settings accepted: %#v", value)
			}
		})
	}
}

func TestNormalizeNativeRuntimeSettingsFillsMissingBounds(t *testing.T) {
	value := nativeRuntimeSettings{RoutingStrategy: "round-robin", CredentialFailureThreshold: 3}
	changed := normalizeNativeRuntimeSettings(&value, []byte(`{"routing_strategy":"round-robin"}`), false, "deny")
	if !changed {
		t.Fatal("missing bounds were not filled")
	}
	if value.RequestTimeoutSeconds != 86400 || value.MaxRequestMiB != 1024 || value.UnpricedModelPolicy != "deny" || value.UpstreamWebSockets {
		t.Fatalf("normalized = %#v", value)
	}
}

func TestNormalizeNativeRuntimeSettingsKeepsStoredWebSocketPolicy(t *testing.T) {
	value := defaultNativeRuntimeSettings()
	value.UpstreamWebSockets = false
	value.UnpricedModelPolicy = "allow"
	value.RequestTimeoutSeconds = 120
	raw := []byte(`{"upstream_websockets":false,"unpriced_model_policy":"allow","request_timeout_seconds":120,"max_request_mib":1024,"request_bytes_in_flight_mib":8192,"memory_reclaim_threshold_mib":8192}`)
	if normalizeNativeRuntimeSettings(&value, raw, true, "deny") {
		t.Fatal("native-era documents must receive CPA defaults")
	}
	if value.UpstreamWebSockets || value.UnpricedModelPolicy != "allow" || value.RequestTimeoutSeconds != 120 {
		t.Fatalf("normalized = %#v", value)
	}

}

func TestNativeRuntimeSettingsAcceptsOperatorPresets(t *testing.T) {
	for _, edit := range []func(*nativeRuntimeSettings){
		func(value *nativeRuntimeSettings) { value.RequestTimeoutSeconds = 120 },
	} {
		value := defaultNativeRuntimeSettings()
		edit(&value)
		if message := validateNativeRuntimeSettings(value); message != "" {
			t.Fatalf("preset rejected (%s): %#v", message, value)
		}
	}
}
