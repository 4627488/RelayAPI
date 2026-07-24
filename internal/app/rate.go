package app

import (
	"sync"
	"time"
)

var rateState = struct {
	sync.Mutex
	requests map[string][]time.Time
}{requests: make(map[string][]time.Time)}

func (a *App) allowRate(key string, limit int) bool {
	if limit <= 0 {
		return true
	}
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	rateState.Lock()
	defer rateState.Unlock()
	values := rateState.requests[key]
	first := 0
	for first < len(values) && values[first].Before(cutoff) {
		first++
	}
	values = append(values[first:], now)
	rateState.requests[key] = values
	return len(values) <= limit
}
