package heatmap

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBuildCalendarAggregatesAndBreaksTiesDeterministically(t *testing.T) {
	now := time.Date(2024, 3, 1, 2, 0, 0, 0, time.FixedZone("local", 8*3600))
	rows := []Usage{{"2024-02-29", "model-b", 30}, {"2024-02-29", "model-a", 20}, {"2024-02-29", "model-a", 10}, {"2024-02-28", "model-b", 2}, {"2024-03-01", "future", 999}, {"2022-01-01", "old", 999}, {"2024-02-27", "bad", -5}}
	r := Build(now, rows)
	if len(r.Days) != 365 || r.End != "2024-02-29" || r.TotalTokens != 62 || r.ActiveDays != 2 || r.PeakTokens != 60 {
		t.Fatalf("bad totals: %+v", r)
	}
	last := r.Days[364]
	if last.Model != "model-a" || last.Tokens != 60 || last.Level != 4 {
		t.Fatalf("day = %+v", last)
	}
	for i := 0; i < len(rows)/2; i++ {
		rows[i], rows[len(rows)-i-1] = rows[len(rows)-i-1], rows[i]
	}
	if !reflect.DeepEqual(r, Build(now, rows)) {
		t.Fatal("map/order changed output")
	}
	for i := 1; i < len(r.Days); i++ {
		previous, _ := time.Parse(time.DateOnly, r.Days[i-1].Date)
		if previous.AddDate(0, 0, 1).Format(time.DateOnly) != r.Days[i].Date {
			t.Fatal("calendar gap")
		}
	}
}

func TestEmptyAndModelOverflow(t *testing.T) {
	now := time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC)
	empty := Build(now, nil)
	if empty.ActiveDays != 0 || len(empty.Days) != 365 || len(empty.Models) != 0 {
		t.Fatal("invalid empty calendar")
	}
	rows := []Usage{}
	for i := 0; i < 12; i++ {
		rows = append(rows, Usage{"2026-09-26", fmt.Sprintf("model-%02d", i), int64(i + 1)})
	}
	r := Build(now, rows)
	if len(r.Models) != 7 || r.Models[6].Name != "Other models" || r.Models[6].Color != OtherColor {
		t.Fatal("unbounded legend")
	}
	var total int64
	for _, m := range r.Models {
		total += m.Tokens
	}
	if total != r.TotalTokens {
		t.Fatal("legend lost tokens")
	}
}

func TestSVGIsValidAndEscapesModelContent(t *testing.T) {
	r := Build(time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC), []Usage{{"2026-09-26", `</text><script>alert("x")</script>&` + "\x01", 42}})
	for _, theme := range []string{"light", "dark", "auto"} {
		raw := SVG(r, theme)
		decoder := xml.NewDecoder(bytes.NewReader(raw))
		for {
			token, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if el, ok := token.(xml.StartElement); ok && (el.Name.Local == "script" || el.Name.Local == "image" || el.Name.Local == "a") {
				t.Fatalf("unsafe element %s", el.Name.Local)
			}
		}
		if strings.Contains(string(raw), "\x01") || !strings.Contains(string(raw), "&lt;script&gt;") {
			t.Fatal("model was not safely escaped")
		}
		if !strings.Contains(string(raw), "42 tokens") {
			t.Fatal("missing summary")
		}
	}
}
