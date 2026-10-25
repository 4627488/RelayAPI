// Package heatmap builds a public, credential-free daily token summary.
package heatmap

import (
	"sort"
	"time"
)

type Usage struct {
	Day    string
	Model  string
	Tokens int64
}

type Day struct {
	Date   string `json:"date"`
	Tokens int64  `json:"tokens"`
	Model  string `json:"model"`
	Level  int    `json:"level"`
	Color  string `json:"color"`
}

type Model struct {
	Name   string `json:"name"`
	Tokens int64  `json:"tokens"`
	Color  string `json:"color"`
}

type Report struct {
	Start       string  `json:"start"`
	End         string  `json:"end"`
	Timezone    string  `json:"timezone"`
	TotalTokens int64   `json:"total_tokens"`
	ActiveDays  int     `json:"active_days"`
	PeakTokens  int64   `json:"peak_tokens"`
	Days        []Day   `json:"days"`
	Models      []Model `json:"models"`
}

// ColorBrewer Dark2: https://colorbrewer2.org/#type=qualitative&scheme=Dark2&n=8
// Six model hues plus a neutral fallback keep the legend readable.
var palette = []string{"#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#a6761d"}

const OtherColor = "#80858f"

// Window covers 365 calendar days including today, independent of DST.
func Window(now time.Time) (time.Time, time.Time) {
	now = now.UTC()
	end := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
	return end.AddDate(0, 0, -365), end
}

func Build(now time.Time, rows []Usage) Report {
	start, end := Window(now)
	r := Report{Start: start.Format(time.DateOnly), End: end.AddDate(0, 0, -1).Format(time.DateOnly), Timezone: "UTC", Days: make([]Day, 0, 365), Models: []Model{}}
	byDay := map[string]map[string]int64{}
	byModel := map[string]int64{}
	for _, row := range rows {
		if row.Day < r.Start || row.Day > r.End || row.Tokens <= 0 {
			continue
		}
		if row.Model == "" {
			row.Model = "Unknown"
		}
		if byDay[row.Day] == nil {
			byDay[row.Day] = map[string]int64{}
		}
		byDay[row.Day][row.Model] += row.Tokens
		byModel[row.Model] += row.Tokens
	}
	for name, tokens := range byModel {
		r.Models = append(r.Models, Model{Name: name, Tokens: tokens})
	}
	sort.Slice(r.Models, func(i, j int) bool {
		if r.Models[i].Tokens != r.Models[j].Tokens {
			return r.Models[i].Tokens > r.Models[j].Tokens
		}
		return r.Models[i].Name < r.Models[j].Name
	})
	colors := map[string]string{}
	var others int64
	for i := range r.Models {
		color := OtherColor
		if i < len(palette) {
			color = palette[i]
		} else {
			others += r.Models[i].Tokens
		}
		r.Models[i].Color = color
		colors[r.Models[i].Name] = color
	}
	if len(r.Models) > len(palette) {
		r.Models = append(r.Models[:len(palette)], Model{Name: "Other models", Tokens: others, Color: OtherColor})
	}
	var nonzero []int64
	for date := start; date.Before(end); date = date.AddDate(0, 0, 1) {
		d := Day{Date: date.Format(time.DateOnly)}
		var favorite int64
		for model, tokens := range byDay[d.Date] {
			d.Tokens += tokens
			if tokens > favorite || (tokens == favorite && model < d.Model) {
				d.Model = model
				favorite = tokens
			}
		}
		if d.Tokens > 0 {
			r.ActiveDays++
			nonzero = append(nonzero, d.Tokens)
			d.Color = colors[d.Model]
		}
		r.TotalTokens += d.Tokens
		if d.Tokens > r.PeakTokens {
			r.PeakTokens = d.Tokens
		}
		r.Days = append(r.Days, d)
	}
	sort.Slice(nonzero, func(i, j int) bool { return nonzero[i] < nonzero[j] })
	for i := range r.Days {
		if r.Days[i].Tokens == 0 {
			continue
		}
		r.Days[i].Level = 1
		for _, q := range []int{1, 2, 3} {
			if r.Days[i].Tokens >= nonzero[(len(nonzero)-1)*q/4] {
				r.Days[i].Level++
			}
		}
	}
	return r
}
