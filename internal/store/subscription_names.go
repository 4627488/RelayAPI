package store

import (
	"fmt"
	"math/big"
	"strings"
)

// DefaultSubscriptionName describes the product and allocated share without
// copying credential names or other private upstream identity into user data.
func DefaultSubscriptionName(parent ParentSubscription, allocationPPM int64) string {
	provider := strings.ToLower(strings.TrimSpace(parent.Provider))
	plan := strings.ToLower(strings.TrimSpace(parent.PlanType))
	product := "共享订阅"
	switch provider {
	case "codex", "openai", "chatgpt":
		product = "ChatGPT"
		if plan == "pro" {
			product += " Pro"
		} else if plan == "plus" {
			product += " Plus"
		}
	case "xai", "grok":
		product = "Grok"
		if strings.Contains(plan, "heavy") {
			product += " SuperHeavy"
		}
	case "claude", "anthropic":
		product = "Claude"
		switch plan {
		case "pro":
			product += " Pro"
		case "max":
			product += " Max"
		case "team":
			product += " Team"
		}
	case "antigravity":
		product = "Antigravity"
	case "aliyun-bailian":
		product = "阿里云百炼"
	case "kimi":
		product = "Kimi"
	}
	if parent.CapacityMode == "unmetered" {
		return product + " 余额付费"
	}
	if allocationPPM <= 0 {
		return product
	}
	if product == "ChatGPT Pro" || provider == "claude" || provider == "anthropic" {
		// Product conventions: a whole ChatGPT Pro is 20X; Claude is 5X.
		divisor := int64(50_000)
		if provider == "claude" || provider == "anthropic" {
			divisor = 200_000
		}
		multiple := new(big.Rat).SetFrac64(allocationPPM, divisor).FloatString(6)
		return product + " " + strings.TrimRight(strings.TrimRight(multiple, "0"), ".") + "X"
	}
	a, b := allocationPPM, int64(1_000_000)
	for b != 0 {
		a, b = b, a%b
	}
	return fmt.Sprintf("%s %d/%d", product, allocationPPM/a, 1_000_000/a)
}
