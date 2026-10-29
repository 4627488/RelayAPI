package rai

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tidwall/sjson"
)

type PrimeAdapter struct{}

func (PrimeAdapter) Name() string { return "prime-agent" }
func (PrimeAdapter) Install() string {
	return "https://github.com/PrimeIntellect-ai/prime-agent#install"
}
func (a PrimeAdapter) Probe() (string, string, error) {
	return (EnvAdapter{BinaryName: "prime-agent", InstallHint: a.Install()}).Probe()
}

func (a PrimeAdapter) Prepare(ctx LaunchContext) (Command, error) {
	if err := requireLocalClientCredential(ctx); err != nil {
		return Command{}, err
	}
	if hasFlag(ctx.Args, "--provider", "--api-key") {
		return Command{}, errors.New("rai manages Prime Agent provider and credentials; select the model with --model")
	}
	dir, err := clientHome(ctx.Environ, "PRIME_AGENT_CODING_AGENT_DIR", ".prime/agent")
	if err != nil {
		return Command{}, err
	}
	path := filepath.Join(dir, "models.json")
	name := launchProviderID(ctx)
	config := map[string]any{
		"name": "RelayAPI (" + ctx.Profile.Name + ")", "api": "openai-completions",
		"baseUrl": v1APIBase(ctx.APIBase), "apiKey": ctx.APIKey,
		"models": piModels(ctx),
	}
	// This is a local-only capability, not an upstream OAuth/access token. It
	// remains usable by daemon workers after the CLI and its environment exit.
	if err := mergeClientProvider(path, name, config); err != nil {
		return Command{}, err
	}
	ctx.Args = append([]string{"--provider", name}, ctx.Args...)
	if ctx.Profile.ReasoningEffort != "" && !hasFlag(ctx.Args, "--thinking") {
		ctx.Args = append([]string{"--thinking", piThinkingLevel(ctx.Profile.ReasoningEffort)}, ctx.Args...)
	}
	return (EnvAdapter{BinaryName: "prime-agent", InstallHint: a.Install(), PassModel: true}).Prepare(ctx)
}

func mergeClientProvider(path, name string, config map[string]any) error {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if config == nil {
			return nil
		}
		raw = []byte(`{}`)
	} else if err != nil {
		return err
	}
	var document map[string]json.RawMessage
	clean := cleanClientJSON(raw)
	if json.Unmarshal(clean, &document) != nil || document == nil {
		return fmt.Errorf("invalid %s: expected a JSON object; existing configuration was retained", path)
	}
	if providers, exists := document["providers"]; exists {
		var values map[string]json.RawMessage
		if json.Unmarshal(providers, &values) != nil || values == nil {
			return fmt.Errorf("invalid providers in %s; existing configuration was retained", path)
		}
	}
	updated, err := patchClientJSON(raw, []string{"providers", name}, config, config != nil)
	if err != nil {
		return err
	}
	if bytes.Equal(raw, updated) {
		return nil
	}
	return writeFileAtomic(path, updated, 0o600)
}

// Edit a JSONC field without rewriting unrelated comments or formatting.
func patchClientJSON(raw []byte, path []string, value any, present bool) ([]byte, error) {
	if raw == nil {
		raw = []byte("{}\n")
	}
	clean, original := normalizeClientJSON(raw)
	parts := make([]string, len(path))
	for i, part := range path {
		parts[i] = strings.NewReplacer("\\", "\\\\", ".", "\\.", "*", "\\*", "?", "\\?").Replace(part)
	}
	var updated []byte
	var err error
	if present {
		updated, err = sjson.SetBytes(clean, strings.Join(parts, "."), value)
	} else {
		updated, err = sjson.DeleteBytes(clean, strings.Join(parts, "."))
	}
	if err != nil {
		return nil, err
	}
	if bytes.Equal(clean, updated) {
		return raw, nil
	}
	prefix, suffix := 0, 0
	for prefix < len(clean) && prefix < len(updated) && clean[prefix] == updated[prefix] {
		prefix++
	}
	for suffix < len(clean)-prefix && suffix < len(updated)-prefix && clean[len(clean)-suffix-1] == updated[len(updated)-suffix-1] {
		suffix++
	}
	patched := append([]byte(nil), original[:prefix]...)
	patched = append(patched, updated[prefix:len(updated)-suffix]...)
	patched = append(patched, original[len(original)-suffix:]...)
	if !json.Valid(cleanClientJSON(patched)) {
		return nil, errors.New("cannot safely edit JSON configuration")
	}
	return patched, nil
}

// Prime accepts JSON with comments and trailing commas. Keep the original
// document for surgical edits, and strip only that syntax for validation.
func cleanClientJSON(raw []byte) []byte {
	clean, _ := normalizeClientJSON(raw)
	return clean
}

func normalizeClientJSON(raw []byte) ([]byte, []byte) {
	clean := append([]byte(nil), raw...)
	original := append([]byte(nil), raw...)
	inString, escaped := false, false
	for i := 0; i < len(clean); i++ {
		b := clean[i]
		if inString {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				inString = false
			}
			continue
		}
		if b == '"' {
			inString = true
			continue
		}
		if b != '/' || i+1 >= len(clean) {
			continue
		}
		if clean[i+1] == '/' {
			for ; i < len(clean) && clean[i] != '\n'; i++ {
				clean[i] = ' '
			}
			continue
		}
		if clean[i+1] == '*' {
			clean[i], clean[i+1] = ' ', ' '
			i += 2
			for ; i+1 < len(clean) && !(clean[i] == '*' && clean[i+1] == '/'); i++ {
				if clean[i] != '\n' && clean[i] != '\r' {
					clean[i] = ' '
				}
			}
			if i+1 < len(clean) {
				clean[i], clean[i+1] = ' ', ' '
				i++
			} else {
				return raw, original
			}
		}
	}
	inString, escaped = false, false
	for i, b := range clean {
		if inString {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				inString = false
			}
			continue
		}
		if b == '"' {
			inString = true
			continue
		}
		if b == ',' {
			for j := i + 1; j < len(clean); j++ {
				if clean[j] == ' ' || clean[j] == '\t' || clean[j] == '\r' || clean[j] == '\n' {
					continue
				}
				if clean[j] == ']' || clean[j] == '}' {
					clean[i] = ' '
					original[i] = ' '
				}
				break
			}
		}
	}
	return clean, original
}
