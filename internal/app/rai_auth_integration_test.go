package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/config"
	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/store"
)

func TestRAIAuthorizationHTTPFlow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	database, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	dataStore, err := store.New(database, "integration-test-encryption-key-at-least-32-bytes")
	if err != nil {
		t.Fatal(err)
	}
	email := "rai-http-" + time.Now().UTC().Format("20060102150405.000000000") + "@example.com"
	if _, err := dataStore.CreateTenant(ctx, "Owner", email, "password123", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	app := &App{
		cfg:   config.Config{PublicURL: "https://relay.example", SessionSecret: "test-session-secret-0123456789abcdef"},
		store: dataStore,
		mux:   http.NewServeMux(),
	}
	app.routes()

	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	create := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]string{
		"device_name":           "laptop",
		"code_challenge":        store.PKCEChallengeS256(verifier),
		"code_challenge_method": "S256",
	})
	app.mux.ServeHTTP(create, httptest.NewRequest(http.MethodPost, "/api/rai/authorizations", bytes.NewReader(body)))
	if create.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", create.Code, create.Body)
	}
	var created map[string]any
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	id, _ := created["authorization_id"].(string)
	if id == "" || !strings.Contains(created["verification_uri"].(string), id) {
		t.Fatalf("created = %#v", created)
	}

	page := httptest.NewRecorder()
	app.mux.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/rai/authorize/"+id, nil))
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "登录") {
		t.Fatalf("page = %d %s", page.Code, page.Body)
	}

	form := url.Values{"email": {email}, "password": {"password123"}}
	login := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/rai/authorize/"+id+"/session", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	app.mux.ServeHTTP(login, req)
	if login.Code != http.StatusSeeOther {
		t.Fatalf("login = %d %s", login.Code, login.Body)
	}
	cookie := login.Result().Header.Get("Set-Cookie")
	if cookie == "" {
		t.Fatal("missing session cookie")
	}

	approve := httptest.NewRecorder()
	approveReq := httptest.NewRequest(http.MethodPost, "/rai/authorize/"+id+"/approve", nil)
	approveReq.Header.Set("Cookie", cookie)
	app.mux.ServeHTTP(approve, approveReq)
	if approve.Code != http.StatusOK || !strings.Contains(approve.Body.String(), "已批准") {
		t.Fatalf("approve = %d %s", approve.Code, approve.Body)
	}

	token := httptest.NewRecorder()
	tokenBody, _ := json.Marshal(map[string]string{"authorization_id": id, "code_verifier": verifier})
	app.mux.ServeHTTP(token, httptest.NewRequest(http.MethodPost, "/api/rai/token", bytes.NewReader(tokenBody)))
	if token.Code != http.StatusOK {
		t.Fatalf("token = %d %s", token.Code, token.Body)
	}
	var issued map[string]any
	if err := json.Unmarshal(token.Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	key, _ := issued["api_key"].(string)
	if !strings.HasPrefix(key, "relay_") {
		t.Fatalf("issued = %#v", issued)
	}
}
