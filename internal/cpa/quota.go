package cpa

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type QuotaReport struct {
	AuthIndex string        `json:"auth_index"`
	Provider  string        `json:"provider"`
	PlanType  string        `json:"plan_type"`
	Supported bool          `json:"supported"`
	Source    string        `json:"source"`
	Observed  time.Time     `json:"observed_at"`
	Windows   []QuotaWindow `json:"windows"`
}

type QuotaWindow struct {
	Kind             string     `json:"kind"`
	Label            string     `json:"label"`
	UsedPercent      *float64   `json:"used_percent"`
	RemainingPercent *float64   `json:"remaining_percent"`
	ResetsAt         *time.Time `json:"resets_at"`
	Enforceable      bool       `json:"enforceable"`
	Unit             string     `json:"unit"`
	Limit            *float64   `json:"limit"`
	Remaining        *float64   `json:"remaining"`
}

func (c *Client) Quota(ctx context.Context, authIndex string) (QuotaReport, error) {
	authIndex = strings.TrimSpace(authIndex)
	if authIndex == "" {
		return QuotaReport{}, fmt.Errorf("auth index is required")
	}
	status, payload, err := c.Management(ctx, http.MethodGet,
		"plugins/relayapi-bridge/quota?auth_index="+url.QueryEscape(authIndex), nil)
	if err != nil {
		return QuotaReport{}, err
	}
	if status < 200 || status >= 300 {
		var response struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(payload, &response)
		message := strings.TrimSpace(response.Error.Message)
		if message == "" {
			message = http.StatusText(status)
		}
		return QuotaReport{}, fmt.Errorf("CPA quota probe returned HTTP %d: %s", status, message)
	}
	var report QuotaReport
	if err := json.Unmarshal(payload, &report); err != nil {
		return QuotaReport{}, fmt.Errorf("decode CPA quota report: %w", err)
	}
	if report.AuthIndex != authIndex {
		return QuotaReport{}, fmt.Errorf("CPA quota report auth index mismatch")
	}
	if report.Observed.IsZero() {
		return QuotaReport{}, fmt.Errorf("CPA quota report has no observation time")
	}
	if report.Windows == nil {
		report.Windows = []QuotaWindow{}
	}
	return report, nil
}
