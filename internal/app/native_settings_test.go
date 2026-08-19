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
	compiled := runtimeSettings(settings, "direct")
	if compiled.RequestRetry != 2 || compiled.RetryMaxBackoff != 2*time.Second {
		t.Fatalf("retry settings = %#v", compiled)
	}
	if compiled.FailureThreshold != 3 || compiled.FailureCooldown != 30*time.Second {
		t.Fatalf("isolation settings = %#v", compiled)
	}
}

func TestNativeRuntimeSettingsValidation(t *testing.T) {
	tests := []struct {
		name string
		edit func(*nativeRuntimeSettings)
	}{
		{"retry", func(value *nativeRuntimeSettings) { value.RequestRetry = 6 }},
		{"backoff", func(value *nativeRuntimeSettings) { value.RetryMaxBackoffMS = 99 }},
		{"routing", func(value *nativeRuntimeSettings) { value.RoutingStrategy = "random" }},
		{"threshold", func(value *nativeRuntimeSettings) { value.CredentialFailureThreshold = 0 }},
		{"cooldown", func(value *nativeRuntimeSettings) { value.CredentialCooldownSeconds = 4 }},
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
