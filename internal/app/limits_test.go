package app

import (
	"context"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestEnforceLimitsSkipsUsageQueryWhenNoDailyLimitExists(t *testing.T) {
	a := &App{}
	if err := a.enforceLimits(context.Background(), store.KeyContext{}); err != nil {
		t.Fatal(err)
	}
}
