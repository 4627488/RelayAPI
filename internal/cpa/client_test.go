package cpa

import "testing"

func TestVersionAtLeast(t *testing.T) {
	if !versionAtLeast("0.2.0", 0, 2, 0) || !versionAtLeast("1.0.0", 0, 2, 0) {
		t.Fatal("expected compatible bridge versions")
	}
	if versionAtLeast("0.1.9", 0, 2, 0) || versionAtLeast("invalid", 0, 2, 0) {
		t.Fatal("expected incompatible bridge version")
	}
}
