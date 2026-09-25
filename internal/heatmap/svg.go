package heatmap

import (
	"fmt"
	"html"
	"strings"
	"time"
)

func compact(n int64) string {
	for _, unit := range []struct {
		value  int64
		suffix string
	}{{1_000_000_000, "B"}, {1_000_000, "M"}, {1_000, "K"}} {
		if n >= unit.value {
			return fmt.Sprintf("%.1f%s", float64(n)/float64(unit.value), unit.suffix)
		}
	}
	return fmt.Sprint(n)
}

func label(s string, limit int) string {
	runes := []rune(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0xfffe || r == 0xffff {
			return -1
		}
		return r
	}, s))
	if len(runes) > limit {
		return string(runes[:limit-1]) + "…"
	}
	return string(runes)
}

// SVG contains only presentation and aggregate usage: no links, scripts,
// external fonts, identifiers, or credentials. All model text is escaped.
func SVG(r Report, theme string) []byte {
	var b strings.Builder
	b.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="324" viewBox="0 0 900 324" role="img" aria-labelledby="title desc">`)
	b.WriteString(`<title id="title">Token activity</title>`)
	fmt.Fprintf(&b, `<desc id="desc">%s tokens across %d active days, %s to %s, UTC. Color indicates the model with the most tokens that day; intensity indicates daily usage.</desc>`, compact(r.TotalTokens), r.ActiveDays, r.Start, r.End)
	b.WriteString(`<style>svg{--bg:#ffffff;--fg:#24292f;--muted:#656d76;--empty:#eff1f3;--border:#d8dee4}text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--fg)}.muted{fill:var(--muted)}.empty{fill:var(--empty)}</style>`)
	const dark = `svg{--bg:#161b22;--fg:#e6edf3;--muted:#a0aab6;--empty:#272f39;--border:#39424e}`
	if theme == "dark" {
		b.WriteString("<style>" + dark + "</style>")
	}
	if theme == "auto" {
		b.WriteString("<style>@media(prefers-color-scheme:dark){" + dark + "}</style>")
	}
	b.WriteString(`<rect x=".5" y=".5" width="899" height="323" rx="12" fill="var(--bg)" stroke="var(--border)"/>`)
	b.WriteString(`<text x="28" y="35" font-size="18" font-weight="600">Token activity</text>`)
	fmt.Fprintf(&b, `<text x="28" y="58" font-size="12" class="muted">%s — %s · All models · UTC</text>`, r.Start, r.End)
	fmt.Fprintf(&b, `<text x="872" y="35" text-anchor="end" font-size="22" font-weight="600">%s<tspan font-size="12" font-weight="400" class="muted"> tokens</tspan></text>`, compact(r.TotalTokens))
	fmt.Fprintf(&b, `<text x="872" y="58" text-anchor="end" font-size="12" class="muted">%d active days</text>`, r.ActiveDays)
	start, _ := time.Parse(time.DateOnly, r.Start)
	offset := int(start.Weekday())
	lastMonth := time.Month(0)
	for i, d := range r.Days {
		date, _ := time.Parse(time.DateOnly, d.Date)
		column, row := (i+offset)/7, (i+offset)%7
		x, y := 56+column*15, 104+row*15
		if date.Month() != lastMonth && (i == 0 || row == 0 || date.Day() == 1) {
			// Avoid overlapping labels when the range starts late in a month.
			if i > 0 || date.Day() < 22 {
				fmt.Fprintf(&b, `<text x="%d" y="91" font-size="10" class="muted">%s</text>`, x, date.Format("Jan"))
			}
			lastMonth = date.Month()
		}
		fmt.Fprintf(&b, `<rect x="%d" y="%d" width="11" height="11" rx="2" class="empty"/>`, x, y)
		color := "var(--empty)"
		opacity := 1.0
		if d.Level > 0 {
			color = d.Color
			opacity = []float64{0, .28, .48, .72, 1}[d.Level]
		}
		fmt.Fprintf(&b, `<rect x="%d" y="%d" width="11" height="11" rx="2" fill="%s" fill-opacity="%.2f"><title>%s · %d tokens`, x, y, color, opacity, d.Date, d.Tokens)
		if d.Model != "" {
			fmt.Fprintf(&b, ` · %s`, html.EscapeString(label(d.Model, 120)))
		}
		b.WriteString(`</title></rect>`)
	}
	for _, day := range []struct {
		row  int
		name string
	}{{1, "Mon"}, {3, "Wed"}, {5, "Fri"}} {
		fmt.Fprintf(&b, `<text x="28" y="%d" font-size="9" class="muted">%s</text>`, 113+day.row*15, day.name)
	}
	if r.ActiveDays == 0 {
		b.WriteString(`<text x="28" y="237" font-size="12" class="muted">No token usage yet. Your activity will appear here.</text>`)
	}
	for i, model := range r.Models {
		x, y := 28+(i%4)*216, 232+(i/4)*25
		fmt.Fprintf(&b, `<rect x="%d" y="%d" width="9" height="9" rx="2" fill="%s"/><text x="%d" y="%d" font-size="11">%s<title>%s</title></text>`, x, y-8, model.Color, x+16, y, html.EscapeString(label(model.Name, 25)), html.EscapeString(label(model.Name, 120)))
	}
	b.WriteString(`<text x="28" y="301" font-size="10" class="muted">Daily top model by tokens · Intensity relative to active days</text><text x="730" y="301" font-size="10" class="muted">Less</text>`)
	for i, opacity := range []float64{.12, .28, .48, .72, 1} {
		fmt.Fprintf(&b, `<rect x="%d" y="291" width="11" height="11" rx="2" fill="#1b9e77" fill-opacity="%.2f"/>`, 758+i*15, opacity)
	}
	b.WriteString(`<text x="839" y="301" font-size="10" class="muted">More</text></svg>`)
	return []byte(b.String())
}
