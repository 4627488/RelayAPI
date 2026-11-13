package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"github.com/tidwall/gjson"
)

// Only actual protocol compaction items count. User text and tool results may
// contain similar JSON and must never influence account selection.
func compactionHashes(payload []byte, input bool) []string {
	if !bytes.Contains(payload, []byte(`"compaction"`)) {
		return nil
	}
	root := gjson.ParseBytes(payload)
	items := root.Get("output").Array()
	if input {
		items = root.Get("input").Array()
	} else {
		items = append(items, root.Get("response.output").Array()...)
		if root.Get("type").String() == "response.output_item.done" {
			items = append(items, root.Get("item"))
		}
	}
	seen := map[string]bool{}
	var hashes []string
	for _, item := range items {
		if item.Get("type").String() != "compaction" {
			continue
		}
		seal := item.Get("encrypted_content").String()
		if seal == "" {
			continue
		}
		hash := fmt.Sprintf("%x", sha256.Sum256([]byte(seal)))
		if !seen[hash] {
			seen[hash] = true
			hashes = append(hashes, hash)
		}
	}
	return hashes
}

func (a *App) compactionCredential(ctx context.Context, tenant string, payload []byte) (string, error) {
	return a.store.CompactionCredential(ctx, tenant, compactionHashes(payload, true))
}

func (a *App) rememberCompaction(ctx context.Context, tenant, credential string, payload []byte) error {
	hashes := compactionHashes(payload, false)
	if len(hashes) == 0 {
		return nil
	}
	if credential == "" {
		return fmt.Errorf("cannot persist compaction without an admitted upstream account")
	}
	persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	err := a.store.RememberCompactionRoute(persistCtx, tenant, credential, hashes)
	a.observePersistence("compaction_route", err)
	return err
}

// A compaction must be durable before its last JSON chunk / SSE event reaches
// the client: Codex may submit the next turn immediately, before billing runs.
type compactionObserver struct {
	stream bool
	limit  int
	json   []byte
	events firstTokenObserver
	record func([]byte) error
	err    error
}

func newCompactionObserver(stream bool, limit int, record func([]byte) error) *compactionObserver {
	o := &compactionObserver{stream: stream, limit: limit, record: record}
	o.events.eventLimit = limit
	o.events.onEvent = func(event []byte) {
		if o.err == nil {
			o.err = record(event)
		}
	}
	return o
}
func (o *compactionObserver) Write(payload []byte) error {
	if o.stream {
		o.events.Write(payload, time.Now())
		return o.err
	}
	if len(o.json)+len(payload) > o.limit {
		return fmt.Errorf("Responses JSON exceeds the compaction routing limit")
	}
	o.json = append(o.json, payload...)
	if bytes.Contains(o.json, []byte(`"compaction"`)) && gjson.ValidBytes(o.json) {
		o.err = o.record(o.json)
	}
	return o.err
}
