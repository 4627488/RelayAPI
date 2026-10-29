package rai

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"

	"github.com/pelletier/go-toml/v2"
	"gopkg.in/yaml.v3"
)

type clientConfigFile struct {
	Path, Format     string
	Raw              []byte
	Before, Document map[string]any
}

func readClientConfig(path, format string) (*clientConfigFile, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		raw = nil
	} else if err != nil {
		return nil, err
	}
	doc, err := decodeClientConfig(raw, format)
	if err != nil {
		return nil, fmt.Errorf("invalid %s configuration at %s; existing file was retained", format, path)
	}
	copy, err := decodeClientConfig(raw, format)
	if err != nil {
		return nil, err
	}
	return &clientConfigFile{Path: path, Format: format, Raw: raw, Before: copy, Document: doc}, nil
}

func decodeClientConfig(raw []byte, format string) (map[string]any, error) {
	doc := map[string]any{}
	if len(bytes.TrimSpace(raw)) == 0 {
		return doc, nil
	}
	var err error
	switch format {
	case "json":
		err = json.Unmarshal(cleanClientJSON(raw), &doc)
	case "toml":
		err = toml.Unmarshal(raw, &doc)
	case "yaml":
		err = yaml.Unmarshal(raw, &doc)
	default:
		return nil, errors.New("unknown client config format")
	}
	if err != nil || doc == nil {
		return nil, errors.New("expected a configuration object")
	}
	return doc, nil
}

func configSet(doc map[string]any, path []string, value any) error {
	for _, part := range path[:len(path)-1] {
		if child, ok := doc[part]; ok {
			table, ok := child.(map[string]any)
			if !ok {
				return fmt.Errorf("configuration field %s must be an object", part)
			}
			doc = table
		} else {
			table := map[string]any{}
			doc[part] = table
			doc = table
		}
	}
	doc[path[len(path)-1]] = value
	return nil
}

func configDelete(doc map[string]any, path ...string) {
	for _, part := range path[:len(path)-1] {
		next, ok := doc[part].(map[string]any)
		if !ok {
			return
		}
		doc = next
	}
	delete(doc, path[len(path)-1])
}

func (f *clientConfigFile) render(doc map[string]any) ([]byte, error) {
	if reflect.DeepEqual(f.Before, doc) {
		return f.Raw, nil
	}
	switch f.Format {
	case "toml":
		return toml.Marshal(doc)
	case "yaml":
		var node yaml.Node
		if len(bytes.TrimSpace(f.Raw)) == 0 {
			if err := node.Encode(map[string]any{}); err != nil {
				return nil, err
			}
		} else if err := yaml.Unmarshal(f.Raw, &node); err != nil {
			return nil, err
		}
		root := &node
		if node.Kind == yaml.DocumentNode {
			root = node.Content[0]
		}
		if err := patchClientYAML(root, f.Before, doc); err != nil {
			return nil, err
		}
		return yaml.Marshal(&node)
	case "json":
		raw := f.Raw
		err := visitConfigChanges(f.Before, doc, nil, func(path []string, value any, present bool) error {
			var err error
			raw, err = patchClientJSON(raw, path, value, present)
			return err
		})
		return raw, err
	}
	return nil, errors.New("unknown client config format")
}

func visitConfigChanges(before, after map[string]any, prefix []string, visit func([]string, any, bool) error) error {
	keys := map[string]bool{}
	for k := range before {
		keys[k] = true
	}
	for k := range after {
		keys[k] = true
	}
	ordered := make([]string, 0, len(keys))
	for k := range keys {
		ordered = append(ordered, k)
	}
	sort.Strings(ordered)
	for _, key := range ordered {
		b, bok := before[key]
		a, aok := after[key]
		if bok == aok && reflect.DeepEqual(b, a) {
			continue
		}
		path := append(append([]string(nil), prefix...), key)
		bm, bmap := b.(map[string]any)
		am, amap := a.(map[string]any)
		if bmap && amap {
			if err := visitConfigChanges(bm, am, path, visit); err != nil {
				return err
			}
		} else if err := visit(path, a, aok); err != nil {
			return err
		}
	}
	return nil
}

func patchClientYAML(node *yaml.Node, before, after map[string]any) error {
	if node.Kind != yaml.MappingNode {
		return errors.New("expected a YAML mapping")
	}
	return visitConfigChanges(before, after, nil, func(path []string, value any, present bool) error {
		current := node
		for _, key := range path[:len(path)-1] {
			var next *yaml.Node
			for i := 0; i < len(current.Content); i += 2 {
				if current.Content[i].Value == key {
					next = current.Content[i+1]
					break
				}
			}
			if next == nil {
				next = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
				current.Content = append(current.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, next)
			}
			if next.Kind != yaml.MappingNode {
				return errors.New("expected a YAML mapping")
			}
			current = next
		}
		key := path[len(path)-1]
		for i := 0; i < len(current.Content); i += 2 {
			if current.Content[i].Value != key {
				continue
			}
			if !present {
				current.Content = append(current.Content[:i], current.Content[i+2:]...)
				return nil
			}
			old := current.Content[i+1]
			if key == "custom_providers" && old.Kind == yaml.SequenceNode {
				if entries, ok := value.([]any); ok {
					replacement, err := patchProviderSequence(old, entries)
					if err != nil {
						return err
					}
					current.Content[i+1] = replacement
					return nil
				}
			}
			var replacement yaml.Node
			if err := replacement.Encode(value); err != nil {
				return err
			}
			replacement.HeadComment, replacement.LineComment, replacement.FootComment = old.HeadComment, old.LineComment, old.FootComment
			current.Content[i+1] = &replacement
			return nil
		}
		if present {
			var replacement yaml.Node
			if err := replacement.Encode(value); err != nil {
				return err
			}
			current.Content = append(current.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &replacement)
		}
		return nil
	})
}

func patchProviderSequence(old *yaml.Node, entries []any) (*yaml.Node, error) {
	replacement := *old
	replacement.Content = nil
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("Hermes custom provider must be an object")
		}
		var node *yaml.Node
		for _, candidate := range old.Content {
			var current map[string]any
			if candidate.Decode(&current) != nil {
				continue
			}
			if current["name"] != entry["name"] {
				continue
			}
			node = candidate
			if err := patchClientYAML(node, current, entry); err != nil {
				return nil, err
			}
			break
		}
		if node == nil {
			node = &yaml.Node{}
			if err := node.Encode(entry); err != nil {
				return nil, err
			}
		}
		replacement.Content = append(replacement.Content, node)
	}
	return &replacement, nil
}

// Restore only unchanged rai values. Provider/auth blocks are indivisible so
// an edited endpoint can never be combined with an old credential.
func restoreClientConfig(current, before, after map[string]any, path string) {
	keys := map[string]bool{}
	for k := range before {
		keys[k] = true
	}
	for k := range after {
		keys[k] = true
	}
	for key := range keys {
		b, bok := before[key]
		a, aok := after[key]
		c, cok := current[key]
		if bok == aok && reflect.DeepEqual(b, a) {
			continue
		}
		if key == "custom_providers" && path == "" {
			restoreNamedProviders(current, before, after)
			continue
		}
		bm, bmap := b.(map[string]any)
		am, amap := a.(map[string]any)
		cm, cmap := c.(map[string]any)
		atomic := path == "providers" || path == "provider" || path == "model" || path == "env"
		if !atomic && (bmap || !bok) && (amap || !aok) && (cmap || !cok) {
			if !cok && aok {
				continue
			}
			if cm == nil {
				cm = map[string]any{}
			}
			next := key
			if path != "" {
				next = path + "." + key
			}
			restoreClientConfig(cm, bm, am, next)
			if len(cm) > 0 || bok {
				current[key] = cm
			} else {
				delete(current, key)
			}
			continue
		}
		if cok == aok && reflect.DeepEqual(c, a) {
			if bok {
				current[key] = b
			} else {
				delete(current, key)
			}
		}
	}
}

func restoreNamedProviders(current, before, after map[string]any) {
	if value, present := current["custom_providers"]; present {
		if _, ok := value.([]any); !ok {
			return
		}
	}
	entries, _ := current["custom_providers"].([]any)
	b, _ := before["custom_providers"].([]any)
	a, _ := after["custom_providers"].([]any)
	index := func(items []any) map[string]any {
		m := map[string]any{}
		for _, item := range items {
			if entry, ok := item.(map[string]any); ok {
				if name, ok := entry["name"].(string); ok {
					m[name] = item
				}
			}
		}
		return m
	}
	bm, am := index(b), index(a)
	for name, installed := range am {
		original, existed := bm[name]
		if existed && reflect.DeepEqual(original, installed) {
			continue
		}
		for i, item := range entries {
			entry, _ := item.(map[string]any)
			if entry["name"] == name && reflect.DeepEqual(item, installed) {
				if existed {
					entries[i] = original
				} else {
					entries = append(entries[:i], entries[i+1:]...)
				}
				break
			}
		}
	}
	if len(entries) == 0 && before["custom_providers"] == nil {
		delete(current, "custom_providers")
	} else {
		current["custom_providers"] = entries
	}
}

func clientConfigJournalPath(path, agent string) string {
	return path + ".rai-" + strings.ReplaceAll(agent, "-", "_") + ".json"
}
