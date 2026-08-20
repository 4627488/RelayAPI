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

func TestSubscriptionModelGrantExpandsTenantPoolButRespectsKeyPolicy(t *testing.T) {
	key := KeyContext{
		APIKey:       APIKey{ModelAllowlist: []string{"gpt-*", "grok-4.6"}},
		TenantModels: []string{"gpt-5.6"},
		SubscriptionModelGrants: []SubscriptionModelGrant{{
			ParentModels:   []string{"grok-*"},
			UpstreamModels: []string{"grok-4.6", "grok-4.5"},
		}},
	}
	if !key.AllowsModel("gpt-5.6") {
		t.Fatal("ordinary key and tenant permission should remain available")
	}
	if !key.AllowsModel("grok-4.6") {
		t.Fatal("selected subscription model should pass the key allowlist")
	}
	if key.AllowsModel("grok-4.5") {
		t.Fatal("subscription model omitted from the key allowlist was allowed")
	}
	if key.AllowsModel("claude-sonnet-4-6") {
		t.Fatal("model outside ordinary and subscription permissions was allowed")
	}

	key.ModelAllowlist = nil
	if !key.AllowsModel("grok-4.5") {
		t.Fatal("an empty key allowlist should inherit all tenant and subscription models")
	}
}

func TestCanonicalBalanceGrantHasNoQuotaSliceConfiguration(t *testing.T) {
	now := time.Now()
	expires := now.Add(time.Hour)
	got := canonicalBalanceGrant(ParentSubscription{ID: "parent", Name: "Grok account"}, ChildSubscription{
		Name: "custom", AllocationPPM: 10_000, Priority: 999,
		ModelAllowlist: []string{"grok-4.6"}, ExpiresAt: &expires,
	})
	if got.ParentSubscriptionID != "parent" || got.Name != "Grok account" || got.AllocationPPM != 1_000_000 || got.Priority != 100 || len(got.ModelAllowlist) != 0 || got.ExpiresAt != nil {
		t.Fatalf("balance grant retained quota-slice configuration: %+v", got)
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
	if deltaMicros >= quotaCalibrationMinDeltaMicros {
		t.Fatal("a 0.01% movement should accumulate instead of producing a noisy estimate")
	}
	stableDelta := int64(math.Round((10.1 - 10.0) * 1_000_000))
	if stableDelta < quotaCalibrationMinDeltaMicros {
		t.Fatal("a cumulative 0.1% movement should be eligible for calibration")
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
