package rai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type QuotaWindow struct {
	Kind            string    `json:"kind"`
	LimitNanoUSD    int64     `json:"limit_nano_usd"`
	SettledNanoUSD  int64     `json:"settled_nano_usd"`
	ReservedNanoUSD int64     `json:"reserved_nano_usd"`
	ResetsAt        time.Time `json:"resets_at"`
}

type QuotaItem struct {
	Name     string        `json:"name"`
	Provider string        `json:"provider"`
	Windows  []QuotaWindow `json:"windows"`
}

func (g Gateway) Quota(ctx context.Context, apiBase, apiKey string) ([]QuotaItem, error) {
	if strings.HasPrefix(apiKey, "rai_at_") {
		g = g.managementGateway()
	}
	apiBase, err := normalizeServerURL(apiBase)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+"/api/rai/quota", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("quota %s", resp.Status)
	}
	var result struct {
		Items []QuotaItem `json:"items"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&result); err != nil {
		return nil, fmt.Errorf("parse quota: %w", err)
	}
	return result.Items, nil
}

func (a *App) quota(ctx context.Context, profileName string) error {
	store, err := a.store()
	if err != nil {
		return err
	}
	profile, err := store.ResolveProfile(profileName)
	if err != nil {
		return err
	}
	secret, err := a.profileCredential(ctx, store, profile)
	if err != nil {
		return err
	}
	items, err := a.Gateway.Quota(ctx, profile.ServerURL, secret)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		fmt.Fprintln(a.Stdout, "当前 API Key 没有可用的订阅额度窗口；按余额结算的模型不显示周期额度。")
		return nil
	}
	ui := a.terminal(a.Stdout)
	ui.heading(fmt.Sprintf("订阅额度（%s）", profile.Name))
	for _, item := range items {
		fmt.Fprintln(a.Stdout)
		ui.heading(fmt.Sprintf("%s (%s)", item.Name, item.Provider))
		if len(item.Windows) == 0 {
			fmt.Fprintln(a.Stdout, "  暂无额度窗口")
			continue
		}
		for _, window := range item.Windows {
			used := window.SettledNanoUSD + window.ReservedNanoUSD
			remaining := max(0, window.LimitNanoUSD-used)
			if ui.rich && window.LimitNanoUSD > 0 {
				bar, percent := quotaBar(used, window.LimitNanoUSD)
				color := "32"
				if percent >= 90 {
					color = "31"
				} else if percent >= 70 {
					color = "33"
				}
				fmt.Fprintf(a.Stdout, "  %-6s %s %3d%% used\n", terminalText(window.Kind), ui.paint(color, bar), percent)
				fmt.Fprintf(a.Stdout, "         已用 $%.4f / $%.4f  剩余 $%.4f\n         重置 %s\n", float64(used)/1e9, float64(window.LimitNanoUSD)/1e9, float64(remaining)/1e9, window.ResetsAt.Local().Format("2006-01-02 15:04 MST"))
				continue
			}
			fmt.Fprintf(a.Stdout, "  %s  已用 $%.4f / $%.4f  剩余 $%.4f  重置 %s\n",
				window.Kind, float64(used)/1e9, float64(window.LimitNanoUSD)/1e9,
				float64(remaining)/1e9, window.ResetsAt.Local().Format("2006-01-02 15:04 MST"))
		}
	}
	return nil
}
