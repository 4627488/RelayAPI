package store

import (
	"sync"
	"testing"

	"gorm.io/gorm/schema"
)

func TestResolveKeySchemaAcceptsTenantModelArray(t *testing.T) {
	// ResolveKey joins a PostgreSQL array into a query-only result type. GORM
	// must recognize its type even when the array's zero-value is nil.
	parsed, err := schema.Parse(&joinedKey{}, &sync.Map{}, schema.NamingStrategy{})
	if err != nil {
		t.Fatalf("parse authentication result: %v", err)
	}
	field := parsed.LookUpField("tenant_models")
	if field == nil || field.DataType != "text[]" {
		t.Fatalf("tenant model field = %+v", field)
	}
	var row joinedKey
	if err := row.TenantModels.Scan(`{"gpt-6-sol","gpt-6.1-sol"}`); err != nil {
		t.Fatal(err)
	}
	key := KeyContext{APIKey: APIKey{ModelAllowlist: []string{"gpt-6.1-sol", "ungranted"}}, TenantModels: row.TenantModels}
	if !key.AllowsModel("gpt-6.1-sol") || key.AllowsModel("ungranted") {
		t.Fatal("tenant array must continue to restrict key model access")
	}
}
