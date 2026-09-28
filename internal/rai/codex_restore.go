package rai

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

type codexJournal struct {
	Version       int
	Before, After []byte
}

func codexJournalPath(path string, temporary bool) string {
	if temporary {
		return path + ".rai-temporary.json"
	}
	return path + ".rai-managed.json"
}

func readCodexJournal(path string) (codexJournal, []byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return codexJournal{}, nil, err
	}
	var journal codexJournal
	if json.Unmarshal(raw, &journal) != nil || journal.Version != 1 {
		return journal, nil, errors.New("invalid rai Codex recovery record; preserve it for manual recovery")
	}
	return journal, raw, nil
}

func codexDocument(raw []byte) (map[string]any, error) {
	doc := map[string]any{}
	if err := toml.Unmarshal(raw, &doc); err != nil {
		return nil, errors.New("invalid TOML in Codex recovery record")
	}
	return doc, nil
}

// Three-way restoration touches only rai changes whose installed values still
// match. User edits to unrelated fields and to managed fields both survive.
func restoreCodexFields(current, before, after map[string]any) {
	restoreCodexFieldsAt(current, before, after, "")
}

// Authentication and its destination are one unit: never combine an old secret
// with a user-edited helper or URL. Other headers remain independently editable.
func codexAuthGroup(provider map[string]any) map[string]any {
	group := map[string]any{}
	for _, key := range []string{"base_url", "auth", "experimental_bearer_token", "env_key", "env_key_instructions", "requires_openai_auth"} {
		if value, ok := provider[key]; ok {
			group[key] = value
		}
	}
	for _, key := range []string{"http_headers", "env_http_headers"} {
		if headers, ok := provider[key].(map[string]any); ok {
			for name, value := range headers {
				if strings.EqualFold(name, "Authorization") {
					group[key+"."+name] = value
				}
			}
		}
	}
	return group
}

func restoreCodexFieldsAt(current, before, after map[string]any, path string) {
	if path == "model_providers."+providerID {
		cg, bg, ag := codexAuthGroup(current), codexAuthGroup(before), codexAuthGroup(after)
		if !reflect.DeepEqual(cg, ag) {
			// Mask this group's changes without modifying either journal snapshot.
			before = cloneCodexMap(before)
			after = cloneCodexMap(after)
			for key := range bg {
				maskCodexAuthField(before, key)
			}
			for key := range ag {
				maskCodexAuthField(after, key)
			}
		} else {
			// auth itself must be restored atomically, including removed members.
			if value, ok := before["auth"]; ok {
				current["auth"] = value
			} else {
				delete(current, "auth")
			}
		}
	}
	keys := map[string]bool{}
	for k := range before {
		keys[k] = true
	}
	for k := range after {
		keys[k] = true
	}
	for k := range keys {
		if path == "model_providers."+providerID && k == "auth" {
			continue
		}
		b, bok := before[k]
		a, aok := after[k]
		c, cok := current[k]
		if !cok && aok {
			continue // Preserve a user's deletion of an installed field or table.
		}
		if bok == aok && reflect.DeepEqual(b, a) {
			continue
		}
		bm, bmap := b.(map[string]any)
		am, amap := a.(map[string]any)
		cm, cmap := c.(map[string]any)
		if (bmap || !bok) && (amap || !aok) && (cmap || !cok) {
			if cm == nil {
				cm = map[string]any{}
			}
			next := k
			if path != "" {
				next = path + "." + k
			}
			restoreCodexFieldsAt(cm, bm, am, next)
			if len(cm) > 0 || bok {
				current[k] = cm
			} else {
				delete(current, k)
			}
			continue
		}
		if cok != aok || !reflect.DeepEqual(c, a) {
			continue
		}
		if bok {
			current[k] = b
		} else {
			delete(current, k)
		}
	}
}

func cloneCodexMap(source map[string]any) map[string]any {
	copy := map[string]any{}
	for key, value := range source {
		copy[key] = value
	}
	return copy
}

func maskCodexAuthField(document map[string]any, key string) {
	if table, name, ok := strings.Cut(key, "."); ok {
		headers, _ := document[table].(map[string]any)
		headers = cloneCodexMap(headers)
		delete(headers, name)
		document[table] = headers
	} else {
		delete(document, key)
	}
}

func saveCodexManaged(path string, before, after []byte, temporary bool) error {
	journalPath := codexJournalPath(path, temporary)
	previous, previousRaw, err := readCodexJournal(journalPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	baseline := before
	if err == nil {
		if temporary {
			return errors.New("temporary configuration already exists; restore it first")
		}
		current, err := codexDocument(before)
		if err != nil {
			return err
		}
		oldBefore, err := codexDocument(previous.Before)
		if err != nil {
			return err
		}
		oldAfter, err := codexDocument(previous.After)
		if err != nil {
			return err
		}
		if bytes.Equal(before, previous.After) {
			baseline = previous.Before
		} else {
			restoreCodexFields(current, oldBefore, oldAfter)
			baseline, err = toml.Marshal(current)
			if err != nil {
				return err
			}
		}
	}
	raw, err := json.Marshal(codexJournal{Version: 1, Before: baseline, After: after})
	if err != nil {
		return err
	}
	// Record intent before changing config so a killed process is recoverable.
	if err := writeFileAtomic(journalPath, raw, 0o600); err != nil {
		return err
	}
	if err := writeFileAtomic(path, after, 0o600); err != nil {
		if previousRaw != nil {
			_ = writeFileAtomic(journalPath, previousRaw, 0o600)
		} else {
			_ = os.Remove(journalPath)
		}
		return err
	}
	return nil
}

func restoreCodexManaged(path string, temporary bool) error {
	journalPath := codexJournalPath(path, temporary)
	journal, _, err := readCodexJournal(journalPath)
	if err != nil {
		return err
	}
	original, current, err := loadCodexConfig(path)
	if err != nil {
		return err
	}
	before, err := codexDocument(journal.Before)
	if err != nil {
		return err
	}
	after, err := codexDocument(journal.After)
	if err != nil {
		return err
	}
	restoreCodexFields(current, before, after)
	updated, err := toml.Marshal(current)
	if err != nil {
		return err
	}
	// Restore exact formatting when the user did not edit anything.
	if bytes.Equal(original, journal.After) {
		updated = journal.Before
	}
	latest, _, err := loadCodexConfig(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(original, latest) {
		return errors.New("Codex configuration changed; retry restoration")
	}
	if err := writeFileAtomic(path, updated, 0o600); err != nil {
		return err
	}
	return os.Remove(journalPath)
}

func (a *App) unconfigureCodex(args []string) error {
	if len(args) != 1 || args[0] != "codex" {
		return errors.New("usage: rai unconfigure codex")
	}
	path, err := codexConfigPath(a.Environ)
	if err != nil {
		return err
	}
	temporary := true
	if _, err := os.Stat(codexJournalPath(path, true)); os.IsNotExist(err) {
		temporary = false
	} else if err != nil {
		return err
	}
	if err := restoreCodexManaged(path, temporary); err != nil {
		if os.IsNotExist(err) {
			return errors.New("no managed Codex configuration to restore")
		}
		return err
	}
	fmt.Fprintln(a.Stdout, "Restored rai-managed Codex settings; later user edits were preserved. Restart Codex to apply.")
	return nil
}
