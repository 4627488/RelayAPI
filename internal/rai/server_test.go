package rai

import (
	"bytes"
	"context"
	"testing"
)

func TestLoginTargetPrecedenceAndProfileIdentity(t *testing.T) {
	t.Setenv(envServer, "")
	t.Setenv(envProfile, "")
	app := App{Home: t.TempDir()}
	root, err := app.store()
	if err != nil {
		t.Fatal(err)
	}
	account, err := app.accountStore()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := app.loginTarget("", "", false); err == nil {
		t.Fatal("missing server accepted")
	}
	if err := root.Save(Config{DefaultServer: "https://installed.example"}); err != nil {
		t.Fatal(err)
	}
	check := func(explicit, name string, management bool, wantServer, wantName string) {
		t.Helper()
		server, gotName, err := app.loginTarget(explicit, name, management)
		if err != nil || server != wantServer || gotName != wantName {
			t.Fatalf("target(%q,%q,%v) = %q, %q, %v", explicit, name, management, server, gotName, err)
		}
	}
	check("", "", false, "https://installed.example", "default")
	check("", "", true, "https://installed.example", "default")
	if err := root.PutProfile(Profile{Name: "work", ServerURL: "https://model.example"}); err != nil {
		t.Fatal(err)
	}
	check("", "", false, "https://model.example", "work")
	check("", "", true, "https://model.example", "work")
	if err := account.PutProfile(Profile{Name: "work", ServerURL: "https://account.example"}); err != nil {
		t.Fatal(err)
	}
	check("", "", true, "https://account.example", "work")
	check("", "new", false, "https://installed.example", "new")
	t.Setenv(envProfile, "new")
	check("", "", false, "https://installed.example", "new")
	t.Setenv(envServer, "https://env.example")
	check("", "work", false, "https://env.example", "work")
	check("https://explicit.example/", "work", true, "https://explicit.example", "work")
}

func TestServerSetPreservesProfilesAndSupportsUpdateWithoutLogin(t *testing.T) {
	t.Setenv(envServer, "")
	t.Setenv(envProfile, "")
	app := App{Home: t.TempDir(), Stdout: &bytes.Buffer{}, Args: []string{"server", "set", "https://installed.example/"}}
	store, err := app.store()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PutProfile(Profile{Name: "existing", ServerURL: "https://existing.example"}); err != nil {
		t.Fatal(err)
	}
	if err := app.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	cfg, err := store.Load()
	if err != nil || cfg.DefaultServer != "https://installed.example" || cfg.ActiveProfile != "existing" || cfg.Profiles["existing"].ServerURL != "https://existing.example" {
		t.Fatalf("config = %#v, %v", cfg, err)
	}
	if err := store.DeleteProfile("existing"); err != nil {
		t.Fatal(err)
	}
	if server, err := app.updateServer(); err != nil || server != "https://installed.example" {
		t.Fatalf("update target = %q, %v", server, err)
	}
	app.Args = []string{"server", "set", "invalid"}
	if err := app.Execute(context.Background()); err == nil {
		t.Fatal("invalid server accepted")
	}
}
