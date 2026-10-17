package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/4627488/RelayAPI/internal/db"
	"github.com/4627488/RelayAPI/internal/identity"
)

func TestSharedAssignmentBatchValidationAndLifecycle(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	database, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	dataStore := Store{DB: database}
	ids := []string{identity.NewID(), identity.NewID(), identity.NewID()}
	for index, id := range ids {
		if err := database.Create(&db.Tenant{ID: id, Name: "batch user", OwnerEmail: fmt.Sprintf("%s@example.test", id), PasswordHash: "test", Enabled: index < 2}).Error; err != nil {
			t.Fatal(err)
		}
	}
	// GORM applies Tenant.Enabled's true database default during Create even
	// when a fixture supplies false, so explicitly disable the last user.
	if err := database.Model(&Tenant{}).Where("id = ?", ids[2]).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	parent, err := dataStore.UpsertParentSubscription(ctx, ParentSubscription{UpstreamCredentialID: identity.NewID(), Name: "private@example.test", Provider: "codex", PlanType: "pro", Status: "available", CapacityMode: db.ParentCapacityObserved, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		database.Where("parent_subscription_id = ?", parent.ID).Delete(&ChildSubscription{})
		database.Where("id = ?", parent.ID).Delete(&ParentSubscription{})
		database.Where("id IN ?", ids).Delete(&Tenant{})
	})
	starts := time.Now().UTC().Truncate(time.Second)
	expires := starts.Add(30 * 24 * time.Hour)
	template := ChildSubscription{ParentSubscriptionID: parent.ID, Name: "团队订阅", AllocationPPM: 200000, Priority: 100, Enabled: true, StartsAt: starts, ExpiresAt: &expires}
	assertCount := func(want int64) {
		t.Helper()
		var count int64
		if err := database.Model(&ChildSubscription{}).Where("parent_subscription_id = ?", parent.ID).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != want {
			t.Fatalf("grant count = %d, want %d", count, want)
		}
	}
	for _, invalid := range [][]string{nil, {ids[0], ids[2]}, {ids[0], identity.NewID()}} {
		if _, err := dataStore.CreateSharedSubscriptionGrants(ctx, template, invalid); err == nil {
			t.Fatal("invalid batch accepted")
		}
		assertCount(0)
	}
	invalidTemplate := template
	invalidTemplate.AllocationPPM = 0
	if _, err := dataStore.CreateSharedSubscriptionGrants(ctx, invalidTemplate, ids[:2]); err == nil {
		t.Fatal("invalid share accepted")
	}
	assertCount(0)
	items, err := dataStore.CreateSharedSubscriptionGrants(ctx, template, []string{ids[0], " " + ids[0] + " ", ids[1]})
	if err != nil {
		t.Fatal(err)
	}
	assertCount(2)
	if len(items) != 2 || items[0].ID == items[1].ID {
		t.Fatalf("batch IDs = %+v", items)
	}
	for _, item := range items {
		if item.Name != template.Name || item.AllocationPPM != template.AllocationPPM || !item.StartsAt.Equal(starts) || item.ExpiresAt == nil || !item.ExpiresAt.Equal(expires) {
			t.Fatalf("batch changed lifecycle: %+v", item)
		}
	}
	template.Name = ""
	template.AllocationPPM = 125000
	defaults, err := dataStore.CreateSharedSubscriptionGrants(ctx, template, ids[:1])
	if err != nil || len(defaults) != 1 || defaults[0].Name != "ChatGPT Pro 2.5X" {
		t.Fatalf("default shared name = %+v, err = %v", defaults, err)
	}
}
