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
	"github.com/4627488/RelayAPI/internal/identity"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestRAIManagementAuthorizationAndIsolation(t *testing.T) {
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
	s, err := store.New(database, "integration-test-encryption-key-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	owner, err := s.CreateTenant(ctx, "Owner", identity.NewID()+"@example.com", "password123", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateTenant(ctx, "Other", identity.NewID()+"@example.com", "password123", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	otherKey, _, err := s.CreateKey(ctx, other.ID, "Other secret", nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := &App{cfg: config.Config{PublicURL: "https://relay.example", SessionSecret: "test-session-secret-0123456789abcdef"}, store: s, mux: http.NewServeMux()}
	a.routes()
	request := func(method, path, token, cookie string, input any) *httptest.ResponseRecorder {
		t.Helper()
		var body []byte
		if input != nil {
			body, _ = json.Marshal(input)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		}
		w := httptest.NewRecorder()
		a.mux.ServeHTTP(w, r)
		return w
	}
	expect := func(w *httptest.ResponseRecorder, code int) {
		t.Helper()
		if w.Code != code {
			t.Fatalf("status=%d, wanted %d: %s", w.Code, code, w.Body)
		}
	}
	cookie, _ := identity.SignSession(a.cfg.SessionSecret, identity.Session{Role: "tenant", TenantID: owner.ID, PasswordVersion: owner.PasswordVersion, Expires: time.Now().Add(time.Hour).Unix()})
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	create := request("POST", "/api/rai/authorizations", "", "", map[string]string{
		"purpose": "account", "device_name": "Management test", "code_challenge": store.PKCEChallengeS256(verifier), "code_challenge_method": "S256",
	})
	expect(create, 201)
	var grant struct {
		ID string `json:"authorization_id"`
	}
	_ = json.Unmarshal(create.Body.Bytes(), &grant)
	page := request("GET", "/api/rai/authorizations/"+grant.ID, "", "", nil)
	expect(page, 200)
	if !strings.Contains(page.Body.String(), `"purpose":"account"`) {
		t.Fatal("browser consent omitted account-management purpose")
	}
	expect(request("POST", "/api/rai/authorizations/"+grant.ID+"/approve", "", cookie, nil), 200)
	wrong := map[string]string{"authorization_id": grant.ID, "code_verifier": "incorrect"}
	expect(request("POST", "/api/rai/token", "", "", wrong), 400)
	input := map[string]string{"authorization_id": grant.ID, "code_verifier": verifier}
	exchange := request("POST", "/api/rai/token", "", "", input)
	expect(exchange, 200)
	var issued struct {
		Token   string `json:"access_token"`
		APIKey  string `json:"api_key"`
		Refresh string `json:"refresh_token"`
	}
	_ = json.Unmarshal(exchange.Body.Bytes(), &issued)
	if !strings.HasPrefix(issued.Token, "rai_at_") || issued.APIKey != "" {
		t.Fatal("management grant was confused with an inference Key")
	}
	if exchange.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("token response must not be cached")
	}
	expect(request("POST", "/api/rai/token", "", "", input), 400)
	rotation := request("POST", "/api/rai/token", "", "", map[string]string{"grant_type": "refresh_token", "refresh_token": issued.Refresh})
	expect(rotation, 200)
	var rotated store.RAIOAuthTokens
	_ = json.Unmarshal(rotation.Body.Bytes(), &rotated)
	if rotated.Purpose != "account" || rotated.RefreshToken == issued.Refresh {
		t.Fatal("account authorization did not rotate while preserving its purpose")
	}
	expect(request("POST", "/api/rai/token", "", "", map[string]string{"grant_type": "refresh_token", "refresh_token": issued.Refresh}), 400)
	keys, err := s.ListManualKeys(ctx, owner.ID)
	if err != nil || len(keys) != 0 {
		t.Fatal("management authorization created a manual Key")
	}
	devices, err := s.ListRAIDevices(ctx, owner.ID)
	if err != nil || len(devices) != 1 || devices[0].Purpose != "account" {
		t.Fatalf("devices=%+v, err=%v", devices, err)
	}
	deviceID := devices[0].ID
	for _, path := range []string{"/api/keys", "/api/admin/tenants", "/api/rai/session"} {
		expect(request("GET", path, issued.Token, "", nil), 401)
	}
	_, inference, err := s.CreateKey(ctx, owner.ID, "Inference only", nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	expect(request("GET", "/api/rai/manage/keys", inference, "", nil), 401)
	// Long-lived sockets must not turn a short-lived access token into an
	// unbounded grant. Every new response.create revalidates the device.
	inferenceGrant, _, err := s.CreateRAIAuthorization(ctx, "Socket device", store.PKCEChallengeS256(verifier), "S256", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ApproveRAIAuthorization(ctx, inferenceGrant.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	inferenceAccess, err := s.ConsumeRAIAuthorization(ctx, inferenceGrant.ID, verifier)
	if err != nil {
		t.Fatal(err)
	}
	socketKey, err := s.ResolveKey(ctx, inferenceAccess)
	if err != nil {
		t.Fatal(err)
	}
	socketRequest := httptest.NewRequest(http.MethodGet, "/v1/responses", nil)
	socketRequest.Header.Set("Authorization", "Bearer "+inferenceAccess)
	accounting := &nativeWebSocketAccounting{currentMeta: requestMeta{Model: "m"}}
	frame := []byte(`{"type":"response.create","model":"m"}`)
	if _, _, _, err := a.prepareNativeWebSocketRequest(frame, socketRequest, socketKey, accounting); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeRAIDevice(ctx, owner.ID, socketKey.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := a.prepareNativeWebSocketRequest(frame, socketRequest, socketKey, accounting); err == nil {
		t.Fatal("revoked device continued generating over an existing socket")
	}
	expect(request("GET", "/api/rai/manage/keys", "", cookie, nil), 401)
	for _, path := range []string{"keys", "account", "quota", "usage", "devices", "session"} {
		w := request("GET", "/api/rai/manage/"+path+"?user_id="+other.ID, issued.Token, "", nil)
		expect(w, 200)
		if strings.Contains(w.Body.String(), issued.Token) || strings.Contains(w.Body.String(), "Other secret") || strings.Contains(w.Body.String(), "token_hash") {
			t.Fatal("management read leaked secret or another account")
		}
	}
	expect(request("DELETE", "/api/rai/manage/keys/"+otherKey.ID, issued.Token, "", nil), 404)
	expect(request("PUT", "/api/rai/manage/keys/"+otherKey.ID, issued.Token, "", map[string]any{"Name": "Hijack"}), 404)
	expect(request("DELETE", "/api/rai/manage/devices/"+otherKey.ID, issued.Token, "", nil), 404)
	created := request("POST", "/api/rai/manage/keys", issued.Token, "", map[string]any{"Name": "CLI Key", "RateLimitPerMinute": 5})
	expect(created, 201)
	var result struct {
		Item store.APIKey `json:"item"`
		Key  string       `json:"key"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &result)
	if !strings.HasPrefix(result.Key, "relay_") || result.Item.RateLimitPerMinute == nil || *result.Item.RateLimitPerMinute != 5 {
		t.Fatal("failed to create a constrained inference Key")
	}
	expect(request("GET", "/api/rai/manage/keys/"+result.Item.ID+"/secret", issued.Token, "", nil), 404)
	expect(request("PUT", "/api/rai/manage/keys/"+result.Item.ID, issued.Token, "", map[string]any{"Name": "Updated", "Enabled": false}), 200)
	expect(request("DELETE", "/api/rai/manage/keys/"+result.Item.ID, issued.Token, "", nil), 204)
	// Re-check account state on every request, rather than trusting the initial browser login.
	for _, field := range []string{"password_version", "enabled", "must_change_password", "expires_at"} {
		var value any
		switch field {
		case "password_version":
			value = owner.PasswordVersion + 1
		case "enabled":
			value = false
		case "must_change_password":
			value = true
		case "expires_at":
			value = time.Now().Add(-time.Hour)
		}
		if err := database.Model(&db.Tenant{}).Where("id = ?", owner.ID).Update(field, value).Error; err != nil {
			t.Fatal(err)
		}
		expect(request("GET", "/api/rai/manage/keys", issued.Token, "", nil), 401)
		var restore any
		switch field {
		case "password_version":
			restore = owner.PasswordVersion
		case "enabled":
			restore = true
		case "must_change_password":
			restore = false
		case "expires_at":
			restore = nil
		}
		if err := database.Model(&db.Tenant{}).Where("id = ?", owner.ID).Update(field, restore).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := database.Model(&db.RAIOAuthSession{}).Where("id = ?", deviceID).Update("expires_at", time.Now().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}
	expect(request("GET", "/api/rai/manage/keys", issued.Token, "", nil), 401)
	if err := database.Model(&db.RAIOAuthSession{}).Where("id = ?", deviceID).Update("expires_at", time.Now().Add(time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
	// The existing browser device page can revoke management access immediately.
	expect(request("DELETE", "/api/rai/devices/"+deviceID, "", cookie, nil), 204)
	expect(request("GET", "/api/rai/manage/keys", issued.Token, "", nil), 401)
	expect(request("POST", "/api/rai/token", "", "", map[string]string{"grant_type": "refresh_token", "refresh_token": rotated.RefreshToken}), 400)
}
