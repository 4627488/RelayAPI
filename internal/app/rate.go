package app

import (
	"sync"
	"time"
)

var rateState = struct {
	sync.Mutex
	requests  map[string][]time.Time
	lastSweep time.Time
}{requests: make(map[string][]time.Time)}

func (a *App) allowRate(key string, limit int) bool {
	if limit <= 0 {
		return true
	}
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	rateState.Lock()
	defer rateState.Unlock()
	if rateState.lastSweep.IsZero() || now.Sub(rateState.lastSweep) >= time.Minute {
		for stateKey, timestamps := range rateState.requests {
			firstLive := 0
			for firstLive < len(timestamps) && timestamps[firstLive].Before(cutoff) {
				firstLive++
			}
			if firstLive == len(timestamps) {
				delete(rateState.requests, stateKey)
			} else if firstLive > 0 {
				rateState.requests[stateKey] = append([]time.Time(nil), timestamps[firstLive:]...)
			}
		}
		rateState.lastSweep = now
	}
	values := rateState.requests[key]
	first := 0
	for first < len(values) && values[first].Before(cutoff) {
		first++
	}
	values = values[first:]
	if len(values) >= limit {
		rateState.requests[key] = values
		return false
	}
	values = append(values, now)
	rateState.requests[key] = values
	return true
}
