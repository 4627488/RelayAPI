package app

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/config"
)

func TestHeatmapShareRejectsCrossSiteChanges(t *testing.T) {
	a := &App{cfg: config.Config{PublicURL: "https://relay.example"}}
	for _, origin := range []string{"https://attacker.example", "null", "https://evil.relay.example"} {
		for _, method := range []string{"POST", "DELETE"} {
			r := httptest.NewRequest(method, "/api/usage/heatmap/share", nil)
			r.Header.Set("Origin", origin)
			w := httptest.NewRecorder()
			if a.heatmapShareOrigin(w, r) || w.Code != 403 {
				t.Fatalf("accepted %s %s", method, origin)
			}
		}
	}
	r := httptest.NewRequest("POST", "/api/usage/heatmap/share", nil)
	r.Header.Set("Origin", "https://relay.example")
	if !a.heatmapShareOrigin(httptest.NewRecorder(), r) {
		t.Fatal("rejected own origin")
	}
}

func TestHeatmapMalformedPublicTokensAreNotLookedUp(t *testing.T) {
	a := &App{}
	for _, token := range []string{"", "relay_secret", strings.Repeat("a", 1000), "../../private", strings.Repeat("a", 42) + "!"} {
		r := httptest.NewRequest("GET", "/share/usage/test/heatmap.svg", nil)
		r.SetPathValue("token", token)
		w := httptest.NewRecorder()
		a.sharedHeatmapSVG(w, r)
		if w.Code != 404 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid capability response: %d", w.Code)
		}
	}
}
