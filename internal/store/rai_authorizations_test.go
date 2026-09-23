package store

import (
	"strings"
	"testing"
)

func TestNormalizePKCEChallenge(t *testing.T) {
	ok := strings.Repeat("a", 43)
	if len(ok) != 43 {
		t.Fatalf("fixture length = %d", len(ok))
	}
	got, err := normalizePKCEChallenge(ok)
	if err != nil || got != ok {
		t.Fatalf("got %q err=%v", got, err)
	}
	if _, err := normalizePKCEChallenge("short"); err == nil {
		t.Fatal("expected short challenge error")
	}
}

func TestPKCEChallengeMatches(t *testing.T) {
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	challenge := PKCEChallengeS256(verifier)
	if !pkceChallengeMatches(challenge, verifier) {
		t.Fatal("expected match")
	}
	if pkceChallengeMatches(challenge, "other") {
		t.Fatal("unexpected match")
	}
}

func TestNormalizeRAIDeviceName(t *testing.T) {
	got, err := normalizeRAIDeviceName("  laptop  ")
	if err != nil || got != "laptop" {
		t.Fatalf("got %q err=%v", got, err)
	}
	if _, err := normalizeRAIDeviceName("bad\nname"); err == nil {
		t.Fatal("expected newline error")
	}
}

func TestNormalizeRAIDeviceMetadata(t *testing.T) {
	for _, value := range []string{"bad\nversion", strings.Repeat("a", 65), "bad\x00"} {
		metadata := RAIDeviceMetadata{RAIVersion: value}
		if err := normalizeRAIDeviceMetadata(&metadata); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	metadata := RAIDeviceMetadata{DeviceOS: " windows ", DeviceArch: "amd64", RAIVersion: "dev"}
	if err := normalizeRAIDeviceMetadata(&metadata); err != nil || metadata.DeviceOS != "windows" {
		t.Fatalf("metadata=%+v err=%v", metadata, err)
	}
}
