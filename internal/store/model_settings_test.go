package store

import (
	"context"
	"testing"

	"github.com/4627488/RelayAPI/internal/db"
)

func TestModelSettingRejectsInvalidCodexMetadataBeforeWrite(t *testing.T) {
	for _, item := range []db.ModelSetting{
		{Model: "custom", ReasoningEfforts: []string{"imaginary"}},
		{Model: "custom", DefaultReasoningLevel: "imaginary"},
		{Model: "custom", ReasoningEfforts: []string{"high"}, DefaultReasoningLevel: "none"},
		{Model: "custom", InputModalities: []string{"video"}},
		{Model: "custom", ContextWindow: -1},
	} {
		if _, err := (Store{}).UpsertModelSetting(context.Background(), item); err == nil {
			t.Fatalf("accepted invalid metadata: %+v", item)
		}
	}
}
