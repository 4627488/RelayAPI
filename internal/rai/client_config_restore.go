package rai

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
)

type clientConfigJournal struct {
	Version        int
	Agent, Profile string
	Before, After  []byte
}

func readClientConfigJournal(path, agent string) (clientConfigJournal, []byte, error) {
	var record clientConfigJournal
	raw, err := os.ReadFile(clientConfigJournalPath(path, agent))
	if err != nil {
		return record, nil, err
	}
	if json.Unmarshal(raw, &record) != nil || record.Version != 1 || record.Agent != agent {
		return record, raw, errors.New("invalid rai client recovery record; preserve it for manual recovery")
	}
	return record, raw, nil
}

func restoreConfiguredClient(agent string, current, before, after map[string]any) {
	var groups [][][]string
	if agent == "claude" {
		group := [][]string{{"apiKeyHelper"}}
		for _, key := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"} {
			group = append(group, []string{"env", key})
		}
		groups = append(groups, group)
	}
	if agent == "hermes" {
		if model, ok := before["model"].(string); ok {
			before["model"] = map[string]any{"default": model}
		}
		groups = append(groups, [][]string{{"model", "provider"}, {"model", "base_url"}, {"model", "api_key"}, {"model", "api_mode"}})
	}
	for _, group := range groups {
		matches := true
		for _, path := range group {
			c, cok := configValue(current, path)
			a, aok := configValue(after, path)
			if cok != aok || !reflect.DeepEqual(c, a) {
				matches = false
				break
			}
		}
		if !matches {
			for _, path := range group {
				configDelete(before, path...)
				configDelete(after, path...)
			}
		}
	}
	restoreClientConfig(current, before, after, "")
}

func configValue(doc map[string]any, path []string) (any, bool) {
	for _, key := range path[:len(path)-1] {
		next, ok := doc[key].(map[string]any)
		if !ok {
			return nil, false
		}
		doc = next
	}
	value, exists := doc[path[len(path)-1]]
	return value, exists
}

func configFileState(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return raw, err
}

func replaceConfigFile(path string, raw []byte) error {
	if raw == nil {
		err := os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return writeFileAtomic(path, raw, 0o600)
}

func sameConfigBytes(a, b []byte) bool { return (a == nil) == (b == nil) && bytes.Equal(a, b) }

// Each file records intent before replacement. A failed multi-file update
// rolls back files and journals; interruption recovery uses the same records.
func saveClientConfig(agent, profile string, files []*clientConfigFile) error {
	type write struct {
		file                       *clientConfigFile
		after, journal, oldJournal []byte
	}
	writes := make([]write, 0, len(files))
	for _, file := range files {
		after, err := file.render(file.Document)
		if err != nil {
			return err
		}
		previous, old, err := readClientConfigJournal(file.Path, agent)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		baseline := file.Raw
		if old != nil {
			if sameConfigBytes(file.Raw, previous.After) {
				baseline = previous.Before
			} else {
				current, e := decodeClientConfig(file.Raw, file.Format)
				if e != nil {
					return e
				}
				before, e := decodeClientConfig(previous.Before, file.Format)
				if e != nil {
					return e
				}
				installed, e := decodeClientConfig(previous.After, file.Format)
				if e != nil {
					return e
				}
				restoreConfiguredClient(agent, current, before, installed)
				baseline, e = file.render(current)
				if e != nil {
					return e
				}
			}
		}
		journal, err := json.Marshal(clientConfigJournal{Version: 1, Agent: agent, Profile: profile, Before: baseline, After: after})
		if err != nil {
			return err
		}
		writes = append(writes, write{file, after, journal, old})
	}
	for _, item := range writes {
		current, err := configFileState(item.file.Path)
		if err != nil {
			return err
		}
		if !sameConfigBytes(current, item.file.Raw) {
			return errors.New("client configuration changed during confirmation; run configure again")
		}
	}
	rollback := func(last int, cause error) error {
		for i := last; i >= 0; i-- {
			item := writes[i]
			cause = errors.Join(cause, replaceConfigFile(item.file.Path, item.file.Raw), replaceConfigFile(clientConfigJournalPath(item.file.Path, agent), item.oldJournal))
		}
		return cause
	}
	for i, item := range writes {
		if item.oldJournal == nil && item.file.Raw != nil {
			if err := writeFileAtomic(item.file.Path+".rai.bak", item.file.Raw, 0o600); err != nil {
				return rollback(i-1, err)
			}
		}
		if err := writeFileAtomic(clientConfigJournalPath(item.file.Path, agent), item.journal, 0o600); err != nil {
			return rollback(i, err)
		}
		if err := writeFileAtomic(item.file.Path, item.after, 0o600); err != nil {
			return rollback(i, err)
		}
	}
	return nil
}

func restoreAgentConfig(agent, profile string, files []*clientConfigFile) (bool, error) {
	type restoration struct {
		file *clientConfigFile
		raw  []byte
	}
	plans := []restoration{}
	for _, file := range files {
		record, _, err := readClientConfigJournal(file.Path, agent)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		if profile != "" && record.Profile != profile {
			return false, fmt.Errorf("%s is configured for rai profile %s; select that profile to restore it", agent, record.Profile)
		}
		before, err := decodeClientConfig(record.Before, file.Format)
		if err != nil {
			return false, errors.New("invalid rai client recovery snapshot")
		}
		after, err := decodeClientConfig(record.After, file.Format)
		if err != nil {
			return false, errors.New("invalid rai client recovery snapshot")
		}
		current, err := decodeClientConfig(file.Raw, file.Format)
		if err != nil {
			return false, err
		}
		restoreConfiguredClient(agent, current, before, after)
		updated, err := file.render(current)
		if err != nil {
			return false, err
		}
		if sameConfigBytes(file.Raw, record.After) {
			updated = record.Before
		}
		plans = append(plans, restoration{file, updated})
	}
	for _, plan := range plans {
		latest, err := configFileState(plan.file.Path)
		if err != nil {
			return false, err
		}
		if !sameConfigBytes(latest, plan.file.Raw) {
			return false, errors.New("client configuration changed; retry restoration")
		}
	}
	for i, plan := range plans {
		if err := replaceConfigFile(plan.file.Path, plan.raw); err != nil {
			for j := i - 1; j >= 0; j-- {
				err = errors.Join(err, replaceConfigFile(plans[j].file.Path, plans[j].file.Raw))
			}
			return false, err
		}
	}
	for _, plan := range plans {
		if err := os.Remove(clientConfigJournalPath(plan.file.Path, agent)); err != nil {
			return false, err
		}
	}
	return len(plans) > 0, nil
}
