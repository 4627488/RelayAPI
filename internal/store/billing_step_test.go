package store

import (
	"testing"
	"time"
)

func TestBillingStepLogCannotInheritSessionTotals(t *testing.T) {
	started := time.Now()
	total := int64(900)
	input := WebSocketTurnAccrual{RequestID: "session", TurnID: "response-2", Model: "second-model", Usage: Usage{Total: 7}, CostNanoUSD: 12, PricingComplete: true, RequestBodyBytes: 42, ResponseBodyBytes: 84,
		Log: LogInput{ID: "session", Usage: Usage{Total: 999}, CostNanoUSD: &total, ReservedNanoUSD: 500, Model: "first-model"}}
	log := webSocketStepLog(input, started, started.Add(750*time.Millisecond))
	if log.ID == input.RequestID || log.ReservationRequestID != input.RequestID || log.Model != "second-model" || log.Usage.Total != 7 || *log.CostNanoUSD != 12 || log.ReservedNanoUSD != 0 || log.LatencyMS != 750 || log.RequestBodyBytes != 42 || log.ResponseBodyBytes != 84 {
		t.Fatalf("step leaked session data: %+v", log)
	}
	if log.ID != webSocketStepLog(input, started, started).ID {
		t.Fatal("replay identity changed")
	}
	input.RequestID = "other-session"
	if log.ID == webSocketStepLog(input, started, started).ID {
		t.Fatal("response ids collided between sessions")
	}
	input.PricingComplete = false
	if webSocketStepLog(input, started, started).CostNanoUSD != nil {
		t.Fatal("unknown price was reported as a known charge")
	}
}
