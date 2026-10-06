package app

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/gorilla/websocket"
)

// AI Studio connects an upstream browser worker rather than a downstream model
// client. Only administrators may replace a credential's execution channel.
func (a *App) adminAIStudioChannel(w http.ResponseWriter, r *http.Request) {
	row, err := a.store.GetUpstreamCredential(r.Context(), strings.TrimSpace(r.PathValue("name")))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, "credential_unavailable", "无法读取 AI Studio 账户")
		return
	}
	provider, _ := normalizeSupportedProvider(row.Provider)
	if provider != "aistudio" || !row.Enabled {
		writeError(w, http.StatusBadRequest, "unsupported_channel", "请选择已启用的 AI Studio 账户")
		return
	}
	if !isWebSocketUpgrade(r) {
		writeError(w, http.StatusUpgradeRequired, "websocket_required", "请使用 WebSocket 连接")
		return
	}
	request := r.Clone(r.Context())
	request.URL.Path, request.URL.RawPath, request.URL.RawQuery = "/v1/ws", "", ""
	upstream, response, err := a.dialEmbeddedCPAWebSocket(r.Context(), request, store.Admission{UpstreamCredentialID: row.ID}, "")
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "channel_unavailable", "无法连接 AI Studio 运行时")
		return
	}
	defer upstream.Close()
	downstream, err := (&websocket.Upgrader{HandshakeTimeout: 30 * time.Second}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer downstream.Close()
	downstream.SetReadLimit(a.maxRequestBytes())
	upstream.SetReadLimit(a.maxRequestBytes())
	results := make(chan error, 2)
	go func() { results <- pumpWebSocketMessages(downstream, upstream, nil) }()
	go func() { results <- pumpWebSocketMessages(upstream, downstream, nil) }()
	err = <-results
	forwardWebSocketClose(downstream, err)
	forwardWebSocketClose(upstream, err)
	_ = downstream.Close()
	_ = upstream.Close()
	<-results
}
