package rai

import (
	"fmt"
	"io"
	"strings"
	"time"
	"unicode"

	"github.com/mattn/go-isatty"
)

// terminalUI decorates human output only. JSON, credential helpers and child
// process streams never pass through it.
type terminalUI struct {
	out   io.Writer
	rich  bool
	color bool
}

func (a *App) terminal(w io.Writer) terminalUI {
	fd, ok := w.(interface{ Fd() uintptr })
	rich := ok && (isatty.IsTerminal(fd.Fd()) || isatty.IsCygwinTerminal(fd.Fd()))
	term, noColor := "", false
	for _, entry := range a.Environ {
		key, value, _ := strings.Cut(entry, "=")
		if key == "TERM" {
			term = value
		}
		if key == "NO_COLOR" && value != "" {
			noColor = true
		}
	}
	rich = rich && term != "dumb"
	if rich {
		rich = enableTerminalANSI(fd.Fd())
	}
	return terminalUI{out: w, rich: rich, color: rich && !noColor}
}

// Remote names and error text must not be able to move the cursor or inject
// their own terminal escapes into decorated output.
func terminalText(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
}

func (u terminalUI) paint(code, value string) string {
	if !u.color {
		return value
	}
	return "\x1b[" + code + "m" + value + "\x1b[0m"
}

func (u terminalUI) heading(value string) {
	if u.rich {
		value = u.paint("1", terminalText(value))
	}
	fmt.Fprintln(u.out, value)
}

func (u terminalUI) field(label, value string) {
	if !u.rich {
		fmt.Fprintf(u.out, "%s: %s\n", label, value)
		return
	}
	fmt.Fprintf(u.out, "  %s  %s\n", u.paint("2", fmt.Sprintf("%-18s", label)), terminalText(value))
}

func (u terminalUI) message(kind, format string, args ...any) {
	value := fmt.Sprintf(format, args...)
	if !u.rich {
		fmt.Fprintln(u.out, value)
		return
	}
	mark, color := "›", "36"
	switch kind {
	case "success":
		mark, color = "✓", "32"
	case "warning":
		mark, color = "!", "33"
	case "error":
		mark, color = "×", "31"
	}
	fmt.Fprintf(u.out, "%s %s\n", u.paint(color, mark), terminalText(value))
}

func quotaBar(used, limit int64) (string, int) {
	percent := 0
	if limit > 0 {
		percent = int(min(100.0, max(0.0, float64(used)/float64(limit)*100)))
	}
	filled := percent * 16 / 100
	return "[" + strings.Repeat("#", filled) + strings.Repeat("-", 16-filled) + "]", percent
}

// Progress is driven by actual reads or polling. No goroutine, cursor hiding,
// fake percentage or full-screen terminal state is needed.
type terminalProgress struct {
	ui      terminalUI
	label   string
	last    time.Time
	visible bool
}

func (u terminalUI) progress(label string) *terminalProgress {
	p := &terminalProgress{ui: u, label: terminalText(label)}
	p.update(0, 0)
	return p
}

func (p *terminalProgress) update(done, total int64) {
	if !p.ui.rich {
		return
	}
	if !p.last.IsZero() && time.Since(p.last) < 100*time.Millisecond && (total <= 0 || done < total) {
		return
	}
	p.last = time.Now()
	p.visible = true
	detail := "…"
	if total > 0 {
		bar, percent := quotaBar(done, total)
		detail = fmt.Sprintf("%s %3d%%", bar, percent)
	} else if done > 0 {
		detail = fmt.Sprintf("%.1f MiB", float64(done)/(1<<20))
	}
	fmt.Fprintf(p.ui.out, "\r\x1b[2K%s %s %s", p.ui.paint("36", "›"), p.label, detail)
}

func (p *terminalProgress) clear() {
	if p.ui.rich && p.visible {
		fmt.Fprint(p.ui.out, "\r\x1b[2K")
		p.visible = false
	}
}
