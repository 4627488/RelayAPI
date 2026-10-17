package store

import "testing"

func TestDefaultSubscriptionName(t *testing.T) {
	for _, test := range []struct {
		provider, plan, mode string
		ppm                  int64
		want                 string
	}{
		{"codex", "pro", "observed", 1_000_000, "ChatGPT Pro 20X"},
		{"codex", "pro", "observed", 125_000, "ChatGPT Pro 2.5X"},
		{"codex", "pro", "observed", 100_000, "ChatGPT Pro 2X"},
		{"codex", "pro", "observed", 250_000, "ChatGPT Pro 5X"},
		{"codex", "pro", "observed", 1_250_000, "ChatGPT Pro 25X"},
		{"claude", "", "observed", 1_000_000, "Claude 5X"},
		{"claude", "", "observed", 250_000, "Claude 1.25X"},
		{"claude", "", "observed", 1, "Claude 0.000005X"},
		{"xai", "SuperGrok Heavy", "observed", 250_000, "Grok SuperHeavy 1/4"},
		{"xai", "SuperGrok Heavy", "observed", 500_000, "Grok SuperHeavy 1/2"},
		{"xai", "SuperGrok Heavy", "observed", 333_333, "Grok SuperHeavy 333333/1000000"},
		{"xai", "SuperGrok Heavy", "unmetered", 1_000_000, "Grok SuperHeavy 余额付费"},
		{"antigravity", "native", "unmetered", 1_000_000, "Antigravity 余额付费"},
		{"aliyun-bailian", "native", "unmetered", 1_000_000, "阿里云百炼 余额付费"},
		{"unknown", "private@example.com", "observed", 250_000, "共享订阅 1/4"},
	} {
		t.Run(test.want, func(t *testing.T) {
			parent := ParentSubscription{Name: "private@example.com", Provider: test.provider, PlanType: test.plan, CapacityMode: test.mode}
			if got := DefaultSubscriptionName(parent, test.ppm); got != test.want {
				t.Fatalf("name = %q, want %q", got, test.want)
			}
		})
	}
}
