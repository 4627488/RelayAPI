package app

import (
	"testing"
	"time"
)

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
		{"image_mode", func(value *nativeRuntimeSettings) { value.ImageGenerationMode = "off" }},
		{"image_model", func(value *nativeRuntimeSettings) { value.GPTImageBaseModel = "claude-sonnet" }},
		{"video_ttl", func(value *nativeRuntimeSettings) { value.VideoResultAuthCacheTTL = "3hours" }},
		{"video_ttl_zero", func(value *nativeRuntimeSettings) { value.VideoResultAuthCacheTTL = "0s" }},
		{"keepalive", func(value *nativeRuntimeSettings) { value.StreamKeepAliveSeconds = 301 }},
		{"bootstrap", func(value *nativeRuntimeSettings) { value.StreamBootstrapRetries = -1 }},
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

func TestNormalizeNativeRuntimeSettingsFillsCPAFieldsFromNativeDocument(t *testing.T) {
	value := nativeRuntimeSettings{RoutingStrategy: "round-robin", CredentialFailureThreshold: 3}
	raw := []byte(`{"routing_strategy":"round-robin","credential_failure_threshold":3,"credential_cooldown_seconds":0}`)
	if !normalizeNativeRuntimeSettings(&value, raw, true, "allow") {
		t.Fatal("native-era settings were not migrated")
	}
	if value.RequestRetry != 2 || value.MaxRetryInterval != 30 || !value.PassthroughHeaders ||
		value.ImageGenerationMode != "enabled" || !value.DisableCredentialCooling {
		t.Fatalf("cpa defaults = %#v", value)
	}
	if value.StreamKeepAliveSeconds != 15 || value.GPTImageBaseModel != "gpt-5.4-mini" {
		t.Fatalf("cpa stream defaults = %#v", value)
	}
}

func TestNormalizeNativeRuntimeSettingsKeepsStoredWebSocketPolicy(t *testing.T) {
	value := defaultNativeRuntimeSettings()
	value.UpstreamWebSockets = false
	value.UnpricedModelPolicy = "allow"
	value.RequestTimeoutSeconds = 120
	raw := []byte(`{"upstream_websockets":false,"unpriced_model_policy":"allow","request_timeout_seconds":120,"max_request_mib":1024,"request_bytes_in_flight_mib":8192,"memory_reclaim_threshold_mib":8192}`)
	if !normalizeNativeRuntimeSettings(&value, raw, true, "deny") {
		t.Fatal("native-era documents must receive CPA defaults")
	}
	if value.UpstreamWebSockets || value.UnpricedModelPolicy != "allow" || value.RequestTimeoutSeconds != 120 {
		t.Fatalf("normalized = %#v", value)
	}
	if value.RequestRetry != 2 || !value.DisableCredentialCooling {
		t.Fatalf("cpa defaults = %#v", value)
	}
}

func TestNativeRuntimeSettingsAcceptsOperatorPresets(t *testing.T) {
	for _, edit := range []func(*nativeRuntimeSettings){
		func(value *nativeRuntimeSettings) { value.ImageGenerationMode = "chat" },
		func(value *nativeRuntimeSettings) { value.ImageGenerationMode = "passthrough" },
		func(value *nativeRuntimeSettings) { value.ImageGenerationMode = "disabled" },
		func(value *nativeRuntimeSettings) { value.GPTImageBaseModel = "gpt-5.6-luna" },
		func(value *nativeRuntimeSettings) { value.VideoResultAuthCacheTTL = "30m" },
		func(value *nativeRuntimeSettings) { value.RequestRetry = 0 },
		func(value *nativeRuntimeSettings) { value.MaxRetryInterval = 0 },
		func(value *nativeRuntimeSettings) { value.StreamKeepAliveSeconds = 0 },
		func(value *nativeRuntimeSettings) { value.StreamBootstrapRetries = 3 },
		func(value *nativeRuntimeSettings) { value.RequestTimeoutSeconds = 120 },
	} {
		value := defaultNativeRuntimeSettings()
		edit(&value)
		if message := validateNativeRuntimeSettings(value); message != "" {
			t.Fatalf("preset rejected (%s): %#v", message, value)
		}
	}
}

func TestRuntimeBridgeSettingsMapsImageModes(t *testing.T) {
	value := defaultNativeRuntimeSettings()
	value.ImageGenerationMode = "disabled"
	if compiled := runtimeBridgeSettings(value, ""); compiled.DisableImageGeneration != "all" {
		t.Fatalf("disabled mapped to %q", compiled.DisableImageGeneration)
	}
	value.ImageGenerationMode = "enabled"
	if compiled := runtimeBridgeSettings(value, "direct"); compiled.DisableImageGeneration != "enabled" {
		t.Fatalf("enabled mapped to %q", compiled.DisableImageGeneration)
	}
}
