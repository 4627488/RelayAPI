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
	allowed, _ := a.allowRateAt(key, limit, time.Now())
	return allowed
}

// A rejected request does not extend the sliding window. If the limit was
// lowered, enough of its retained admissions must expire before the next slot.
func (a *App) allowRateAt(key string, limit int, now time.Time) (bool, time.Time) {
	if limit <= 0 {
		return true, time.Time{}
	}
	cutoff := now.Add(-time.Minute)
	rateState.Lock()
	defer rateState.Unlock()
	if rateState.lastSweep.IsZero() || now.Sub(rateState.lastSweep) >= time.Minute {
		for stateKey, timestamps := range rateState.requests {
			firstLive := 0
			for firstLive < len(timestamps) && !timestamps[firstLive].After(cutoff) {
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
	for first < len(values) && !values[first].After(cutoff) {
		first++
	}
	values = values[first:]
	if len(values) >= limit {
		rateState.requests[key] = values
		return false, values[len(values)-limit].Add(time.Minute)
	}
	values = append(values, now)
	rateState.requests[key] = values
	return true, time.Time{}
}
