package cpa

import (
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
