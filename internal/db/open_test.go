package db

import (
	"context"
	"os"
	"sync"
	"testing"
)

func TestOpenSerializesParallelSchemaSetup(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			database, err := Open(ctx, dsn)
			if err != nil {
				errs <- err
				return
			}
			sqlDB, err := database.DB()
			if err != nil {
				errs <- err
				return
			}
			_ = sqlDB.Close()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}
