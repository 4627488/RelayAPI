package upstream

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// DialWebSocket performs a WebSocket handshake against handler over an
// in-memory pipe. Relay keeps the returned connection so it can inspect
// frames for billing; the handler owns provider adaptation.
func DialWebSocket(ctx context.Context, handler http.Handler, path string, header http.Header, subprotocols []string) (*websocket.Conn, *http.Response, error) {
	if handler == nil {
		return nil, nil, fmt.Errorf("native runtime is not available")
	}
	if path == "" {
		path = "/v1/responses"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	clientConn, serverConn := net.Pipe()
	go func() {
		_ = http.Serve(&oneShotListener{conn: serverConn}, handler)
	}()
	dialer := websocket.Dialer{
		HandshakeTimeout:  30 * time.Second,
		EnableCompression: true,
		Subprotocols:      subprotocols,
		NetDialContext: func(context.Context, string, string) (net.Conn, error) {
			return clientConn, nil
		},
	}
	return dialer.DialContext(ctx, "ws://runtime.local"+path, header)
}

type oneShotListener struct {
	conn     net.Conn
	accepted atomic.Bool
}

func (l *oneShotListener) Accept() (net.Conn, error) {
	if l.accepted.CompareAndSwap(false, true) {
		return l.conn, nil
	}
	return nil, net.ErrClosed
}

func (l *oneShotListener) Close() error {
	// http.Serve closes the listener when Accept returns a permanent error.
	// The accepted pipe is hijacked by the WebSocket upgrade and must stay open
	// for the session; the hijacker owns Close.
	return nil
}

func (l *oneShotListener) Addr() net.Addr { return oneShotAddr{} }

type oneShotAddr struct{}

func (oneShotAddr) Network() string { return "pipe" }
func (oneShotAddr) String() string  { return "runtime" }
