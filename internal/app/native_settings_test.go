package app

import (
	"testing"
)

func TestDefaultNativeRuntimeSettingsExposeOnlyEffectiveControls(t *testing.T) {
	settings := defaultNativeRuntimeSettings()
	if message := validateNativeRuntimeSettings(settings); message != "" {
		t.Fatalf("default settings are invalid: %s", message)
	}
	compiled := runtimeSettings(settings, "direct")
	if compiled.FailureThreshold != 3 || compiled.FailureCooldown != 0 {
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
