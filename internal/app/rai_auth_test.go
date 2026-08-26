package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
)

func TestWriteRAITokenErrorCodes(t *testing.T) {
	for _, test := range []struct {
		err  error
		code string
	}{
		{store.ErrAuthorizationPending, "authorization_pending"},
		{store.ErrAuthorizationDenied, "access_denied"},
		{store.ErrAuthorizationExpired, "expired_token"},
		{errors.New("other"), "invalid_grant"},
	} {
		recorder := httptest.NewRecorder()
		writeRAITokenError(recorder, test.err)
		if recorder.Header().Get("X-Relay-Error-Code") != test.code {
			t.Fatalf("%v code = %q", test.err, recorder.Header().Get("X-Relay-Error-Code"))
		}
	}
}

func TestWriteRAIAuthorizeHTMLEscapes(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeRAIAuthorizeHTML(recorder, http.StatusOK, raiAuthorizeView{
		Title: "授权 rai", DeviceName: `<script>alert(1)</script>`, Body: "批准后会创建一把专用 API Key。", CanDecide: true, ID: "abc",
	})
	body := recorder.Body.String()
	if strings.Contains(body, "<script>alert(1)</script>") {
		t.Fatal("device name was not escaped")
	}
	if !strings.Contains(body, "批准") || !strings.Contains(body, "/rai/authorize/abc/approve") {
		t.Fatalf("html = %s", body)
	}
}
