package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
)

var ErrWebSocketReconnect = errors.New("the quota window changed; reconnect to reserve the current window")

// A kept socket is not a permanent entitlement. Check the current grant and
// the exact quota generation held by its reservation before each new turn.
// A changed generation requires reconnecting so admission reserves the new one.
func (s Store) CheckWebSocketTurn(ctx context.Context, key KeyContext, admission Admission, model string) error {
	candidates, assigned, unavailable, err := s.SubscriptionCandidates(ctx, key.TenantID, model, time.Now())
	if err != nil {
		return err
	}
	if admission.ChildSubscriptionID == "" {
		if assigned || unavailable {
			return ErrSubscriptionRequired
		}
		if key.TenantBalance < 0 {
			return ErrInsufficientBalance
		}
		return nil
	}
	var candidate *SubscriptionCandidate
	for i := range candidates {
		if candidates[i].Child.ID == admission.ChildSubscriptionID && candidates[i].Parent.UpstreamCredentialID == admission.UpstreamCredentialID {
			candidate = &candidates[i]
			break
		}
	}
	if candidate == nil {
		return ErrSubscriptionUnavailable
	}
	if candidate.Parent.CapacityMode == db.ParentCapacityUnmetered {
		if key.TenantBalance < 0 {
			return ErrInsufficientBalance
		}
		return nil
	}
	var reservation RequestReservation
	if err = scoped(ctx, s.DB).First(&reservation, "request_id = ? AND status = ? AND expires_at > ?", admission.RequestID, db.ReservationActive, time.Now()).Error; err != nil {
		return ErrSubscriptionUnavailable
	}
	var held []quotaWindowReservation
	if err = json.Unmarshal(reservation.QuotaWindows, &held); err != nil {
		return err
	}
	windows, err := s.ProjectedChildQuotaState(ctx, candidate.Child)
	if err != nil {
		return err
	}
	if len(windows) != len(held) {
		return ErrWebSocketReconnect
	}
	for _, window := range windows {
		matched := false
		for _, h := range held {
			if h.Kind == window.Kind && h.ResetsAt.Equal(window.ResetsAt) {
				matched = true
				break
			}
		}
		if !matched {
			return ErrWebSocketReconnect
		}
		if !window.ResetsAt.After(time.Now()) {
			return ErrSubscriptionUnavailable
		}
		if window.LimitNanoUSD <= 0 || window.SettledNanoUSD+window.ReservedNanoUSD > window.LimitNanoUSD {
			return ErrSubscriptionExhausted
		}
	}
	if len(held) == 0 && key.TenantBalance < 0 {
		return ErrInsufficientBalance
	}
	return nil
}
