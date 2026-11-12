// Package metering defines provider facts independently of pricing and payment.
// Bucket semantics follow yetone/magpie ffc1d64e5e50 (MIT).
package metering

import "math"

// Usage has disjoint input, cache-read and cache-write buckets. Output includes
// reasoning; reasoning is a detail, never an additional billable quantity.
// ImageInput includes cached images, CachedImageInput is its cached subset.
type Usage struct {
	Input, Output, CacheRead, CacheWrite, CacheWrite1h, Reasoning, Total int64
	ImageInput, CachedImageInput, ImageOutput                            int64
	CacheUnknown                                                         bool
}

func Add(values ...int64) int64 {
	var n int64
	for _, v := range values {
		if v > 0 {
			if v > math.MaxInt64-n {
				return math.MaxInt64
			}
			n += v
		}
	}
	return n
}
func (u Usage) Prompt() int64 { return Add(u.Input, u.CacheRead, u.CacheWrite) }
func (u Usage) Tokens() int64 { return Add(u.Input, u.Output) }
func (u Usage) HitRate() *float64 {
	if u.CacheUnknown || u.Prompt() == 0 {
		return nil
	}
	n := float64(u.CacheRead) / float64(u.Prompt())
	return &n
}

// Decode follows Magpie's DecodeOf, including held/burst stream exclusions.
// Unknown timing remains unknown; no output/whole-request speed estimate.
func Decode(output, reasoning, ms, ttft, firstText, flow, firstReasoning int64, hidden bool) (int64, int64) {
	if hidden && firstText <= 0 {
		return 0, 0
	}
	start := ttft
	if reasoning > 0 {
		if firstText > 0 {
			output, start = output-reasoning, firstText
		} else if firstReasoning >= ttft && flow > 0 && reasoning <= output {
			start = firstReasoning
		} else {
			return 0, 0
		}
	}
	w := ms - start
	if ttft <= 0 || output <= 0 || w < 100 || float64(output)*1000 > 10000*float64(w) {
		return 0, 0
	}
	if flow > 0 && float64(flow)*4 < float64(w) {
		return 0, 0
	}
	if w < 1000 && float64(start) > 4*float64(w) {
		return 0, 0
	}
	if reasoning > 0 && firstText > 0 && float64(output)*float64(firstText-ttft) > 20*float64(reasoning)*float64(w) {
		return 0, 0
	}
	return output, w
}
