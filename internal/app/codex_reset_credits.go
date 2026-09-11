package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/gateway"
	"github.com/4627488/RelayAPI/internal/store"
	"github.com/google/uuid"
)

func (a *App) adminCodexResetCredits(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStore(w)
	var input gateway.CodexResetConsumeInput
	if r.Method == http.MethodPost {
		if !decodeJSON(w, r, &input) {
			return
		}
		if _, err := uuid.Parse(input.RedeemRequestID); err != nil {
			writeError(w, http.StatusBadRequest, "validation_error", "重置请求标识必须为 UUID")
			return
		}
	}
	row, err := a.store.GetUpstreamCredential(r.Context(), r.PathValue("name"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "account_not_found", "账户不存在")
		} else {
			writeError(w, http.StatusInternalServerError, "account_unavailable", "无法读取账户")
		}
		return
	}
	if row.Provider != "codex" {
		writeError(w, http.StatusBadRequest, "unsupported_provider", "banked resets 仅支持 Codex OAuth 账户")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	proxyID := ""
	if row.ProxyID != nil {
		proxyID = *row.ProxyID
	}
	proxyURL, err := a.proxyURL(ctx, proxyID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "proxy_unavailable", "无法读取账户代理")
		return
	}
	var result any
	err = a.withCodexResetCredential(ctx, row, proxyURL, func(credential gateway.QuotaProbeCredential) error {
		var callErr error
		if r.Method == http.MethodPost {
			result, callErr = gateway.ConsumeCodexResetCredit(ctx, credential, input)
		} else {
			result, callErr = gateway.ReadCodexResetCredits(ctx, credential)
		}
		return callErr
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, "codex_reset_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) withCodexResetCredential(ctx context.Context, row store.UpstreamCredentialSnapshot, proxyURL string, call func(gateway.QuotaProbeCredential) error) error {
	credential := gateway.QuotaProbeCredential{
		AuthIndex: row.ID, Provider: row.Provider, ProxyURL: proxyURL,
		Document: a.refreshQuotaCredentialDocument(ctx, row.ID, row.Document, false),
	}
	err := call(credential)
	if err == nil || !quotaProbeUnauthorized(err) || a.nativeRuntime == nil {
		return err
	}
	document, _, refreshErr := a.nativeRuntime.RefreshCredential(ctx, strings.TrimSpace(row.ID), true)
	if refreshErr != nil || len(document) == 0 {
		return fmt.Errorf("Codex 授权刷新失败，请重新授权")
	}
	credential.Document = document
	// A consume retry keeps the original redeem_request_id captured by call.
	return call(credential)
}
