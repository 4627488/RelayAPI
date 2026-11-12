package metering

import "testing"

func TestMagpieBucketsAndUnknownCache(t *testing.T) {
	u := Usage{Input: 100, Output: 50, CacheRead: 300, CacheWrite: 100, Reasoning: 20}
	if u.Tokens() != 150 || u.Prompt() != 500 || u.HitRate() == nil || *u.HitRate() != .6 {
		t.Fatalf("wrong disjoint usage: %+v", u)
	}
	u.CacheUnknown = true
	if u.HitRate() != nil {
		t.Fatal("unknown cache is not a miss")
	}
}
func TestMagpieDecodeEvidenceAndHeldStreams(t *testing.T) {
	for _, tc := range []struct {
		name                                         string
		out, reason, ms, first, text, flow, reasonAt int64
		hidden                                       bool
		wantOut, wantMS                              int64
	}{
		{"paced text", 100, 0, 3000, 1000, 1000, 2000, 0, false, 100, 2000},
		{"hidden reasoning with text", 120, 100, 5000, 1000, 4000, 1000, 0, true, 20, 1000},
		{"hidden no text", 120, 100, 5000, 1000, 0, 0, 0, true, 0, 0},
		{"visible reasoning only", 120, 100, 5000, 1000, 0, 4000, 1000, false, 120, 4000},
		{"burst flow", 500, 0, 5000, 1000, 1000, 100, 0, false, 0, 0},
		{"burst after silence", 392, 0, 8450, 8200, 8200, 250, 0, false, 0, 0},
		{"no first content", 100, 0, 3000, 0, 0, 0, 0, false, 0, 0},
		{"one millisecond", 8000, 0, 1001, 1000, 1000, 1, 0, false, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n, ms := Decode(tc.out, tc.reason, tc.ms, tc.first, tc.text, tc.flow, tc.reasonAt, tc.hidden)
			if n != tc.wantOut || ms != tc.wantMS {
				t.Fatalf("got %d/%d want %d/%d", n, ms, tc.wantOut, tc.wantMS)
			}
		})
	}
}
