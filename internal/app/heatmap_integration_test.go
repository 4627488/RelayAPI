package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/heatmap"
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestHeatmapPrivacyAndSharingIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	database, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := database.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	s, err := store.New(database, "heatmap-test-encryption-key-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	tenant, err := s.CreateTenant(ctx, "Private owner", identity.NewID()+"@example.test", "password123", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateTenant(ctx, "Other owner", identity.NewID()+"@example.test", "password123", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	key, secret, err := s.CreateKey(ctx, tenant.ID, "Secret key name", nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	for _, log := range []db.RequestLog{
		{ID: identity.NewID(), TenantID: tenant.ID, APIKeyID: key.ID, Model: "gpt-test", TotalTokens: 40, PromptTokens: 30, CachedTokens: 20, CompletionTokens: 10, StartedAt: day.Add(time.Minute), CompletedAt: now, StatusCode: 200},
		{ID: identity.NewID(), TenantID: tenant.ID, APIKeyID: key.ID, Model: "claude-test", TotalTokens: 25, StartedAt: day.Add(2 * time.Minute), CompletedAt: now, StatusCode: 200},
		{ID: identity.NewID(), TenantID: other.ID, APIKeyID: key.ID, Model: "other-private-model", TotalTokens: 9000, StartedAt: day, CompletedAt: now, StatusCode: 200},
	} {
		if err := database.Create(&log).Error; err != nil {
			t.Fatal(err)
		}
	}
	rollup := db.UsageDailyRollup{Day: day, TenantID: tenant.ID, Model: "gpt-test", TotalTokens: 60, Requests: 1}
	if err := database.Create(&rollup).Error; err != nil {
		t.Fatal(err)
	}
	a := &App{cfg: config.Config{PublicURL: "https://relay.example", SessionSecret: "heatmap-session-secret-0123456789abcdef"}, store: s, mux: http.NewServeMux()}
	a.routes()
	request := func(method, path, cookie string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Cookie", cookie)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	login := func(email string) string {
		body, _ := json.Marshal(map[string]string{"email": email, "password": "password123"})
		w := request("POST", "/api/auth/login", "", body)
		if w.Code != 200 {
			t.Fatalf("login: %d %s", w.Code, w.Body)
		}
		return w.Result().Header.Get("Set-Cookie")
	}
	cookie := login(tenant.OwnerEmail)
	otherCookie := login(other.OwnerEmail)
	if w := request("GET", "/api/usage/heatmap", "", nil); w.Code != 401 {
		t.Fatalf("unauthenticated = %d", w.Code)
	}
	read := request("GET", "/api/usage/heatmap", cookie, nil)
	var report struct {
		heatmap.Report
		SharePath string `json:"share_path"`
	}
	if err := json.Unmarshal(read.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if read.Code != 200 || report.TotalTokens != 125 || report.SharePath != "" || report.Days[364].Model != "gpt-test" {
		t.Fatalf("report: %d %+v", read.Code, report)
	}
	create := request("POST", "/api/usage/heatmap/share", cookie, nil)
	var share struct {
		Path string `json:"share_path"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &share); err != nil {
		t.Fatal(err)
	}
	if create.Code != 200 || share.Path == "" {
		t.Fatalf("create: %d %s", create.Code, create.Body)
	}
	svg := request("GET", share.Path, "", nil)
	if svg.Code != 200 || !strings.HasPrefix(svg.Header().Get("Content-Type"), "image/svg+xml") || svg.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("svg = %d %s", svg.Code, svg.Body)
	}
	if !strings.Contains(svg.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatal("SVG lacks sandbox")
	}
	for _, private := range []string{secret, key.Prefix, key.ID, tenant.ID, tenant.Name, tenant.OwnerEmail, "Secret key name", "other-private-model", "9000"} {
		if strings.Contains(svg.Body.String(), private) || strings.Contains(share.Path, private) {
			t.Fatalf("public output leaked %q", private)
		}
	}
	if !strings.Contains(svg.Body.String(), "125 tokens") {
		t.Fatal("wrong public totals")
	}
	// Revoking another user's share never touches the owner's link.
	if w := request("DELETE", "/api/usage/heatmap/share", otherCookie, nil); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request("GET", share.Path, "", nil); w.Code != 200 {
		t.Fatal("cross-tenant revocation")
	}
	// Sharing capabilities cannot authenticate private APIs or model requests.
	token := strings.Split(share.Path, "/")[3]
	r := httptest.NewRequest("GET", "/api/usage/heatmap", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("share token authorized private API")
	}
	var matchingKeys int64
	if err := database.Model(&db.APIKey{}).Where("key_hash = ?", identity.HashKey(token)).Count(&matchingKeys).Error; err != nil {
		t.Fatal(err)
	}
	if matchingKeys != 0 {
		t.Fatal("share token was registered as an inference key")
	}
	if w := request("GET", share.Path+"?theme=%3Cscript%3E", "", nil); w.Code != 400 {
		t.Fatal("invalid theme accepted")
	}
	rotated := request("POST", "/api/usage/heatmap/share", cookie, nil)
	old := share.Path
	if err := json.Unmarshal(rotated.Body.Bytes(), &share); err != nil {
		t.Fatal(err)
	}
	if old == share.Path {
		t.Fatal("rotation reused token")
	}
	if w := request("GET", old, "", nil); w.Code != 404 {
		t.Fatal("old share still works")
	}
	if w := request("DELETE", "/api/usage/heatmap/share", cookie, nil); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request("GET", share.Path, "", nil); w.Code != 404 {
		t.Fatal("revoked share still works")
	}
	// Disabled users cannot expose data even if their token remains stored.
	token, err = s.RotateHeatmapShare(ctx, tenant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&db.Tenant{}).Where("id = ?", tenant.ID).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	if w := request("GET", heatmapSharePath(token), "", nil); w.Code != 404 {
		t.Fatal("disabled account shared data")
	}
	encoded, _ := json.Marshal(db.Tenant{HeatmapShareToken: &token})
	if bytes.Contains(encoded, []byte(token)) {
		t.Fatal("token leaked through tenant JSON")
	}
}
