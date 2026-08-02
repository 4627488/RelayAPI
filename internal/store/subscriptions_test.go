package store

import (
	"context"
	"math"
	"testing"
	"time"
)

func TestFractionUsesIntegerPartsPerMillion(t *testing.T) {
	tests := []struct {
		value int64
		ppm   int64
		want  int64
	}{
		{1_000_000, 1_000_000, 1_000_000},
		{1_000_000, 250_000, 250_000},
		{10_000_001, 333_333, 3_333_330},
		{9_000_000_000_000, 1_000_000, 9_000_000_000_000},
	}
	for _, test := range tests {
		if got := fraction(test.value, test.ppm); got != test.want {
			t.Fatalf("fraction(%d, %d) = %d, want %d", test.value, test.ppm, got, test.want)
		}
	}
}

func TestModelAllowedCombinesParentAndChildPolicies(t *testing.T) {
	if !modelAllowed("claude-sonnet-4-6", []string{"claude-*"}, []string{"*"}) {
		t.Fatal("expected model to be allowed")
	}
	if modelAllowed("gpt-5.4", []string{"claude-*"}, nil) {
		t.Fatal("child allowlist must restrict model")
	}
	if modelAllowed("claude-sonnet-4-6", nil, []string{"gpt-*"}) {
		t.Fatal("parent allowlist must restrict model")
	}
}

func TestUnmeteredParentDoesNotEnforceAllocationLimit(t *testing.T) {
	if enforcesAllocationLimit("unmetered") {
		t.Fatal("unmetered API-key parent must allow multiple balance-backed child grants")
	}
	for _, mode := range []string{"observed"} {
		if !enforcesAllocationLimit(mode) {
			t.Fatalf("%s parent must enforce its allocation limit", mode)
		}
	}
}

func TestPercentageCapacity(t *testing.T) {
	// $2 priced cost across a 4% upstream movement estimates a $50 window.
	if got := percentageCapacity(2_000_000_000, 4_000_000); got != 50_000_000_000 {
		t.Fatalf("capacity = %d", got)
	}
}

func TestDifferentialPercentagePrecision(t *testing.T) {
	deltaMicros := int64(math.Round((10.01 - 10.0) * 1_000_000))
	if deltaMicros != 10_000 {
		t.Fatalf("delta micros = %d", deltaMicros)
	}
}

func TestMedianInt64RejectsSingleSampleNoise(t *testing.T) {
	if got := medianInt64([]int64{100, 105, 10_000, 95}); got != 102 {
		t.Fatalf("median = %d", got)
	}
	if got := medianInt64([]int64{7, 3, 5}); got != 5 {
		t.Fatalf("odd median = %d", got)
	}
}

func TestObservationRejectsInvalidTimeRangeBeforeDatabaseAccess(t *testing.T) {
	now := time.Now()
	var store Store
	if _, err := store.RecordParentQuotaObservation(context.Background(), "parent", "5h", 25, now.Add(-time.Minute), now); err == nil {
		t.Fatal("expected reset before observation to be rejected")
	}
	if _, err := store.RecordParentQuotaObservation(context.Background(), "parent", "5h", 25, now.Add(time.Hour), now.Add(10*time.Minute)); err == nil {
		t.Fatal("expected future observation to be rejected")
	}
}
