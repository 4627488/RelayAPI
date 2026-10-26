package rai

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type HermesAdapter struct{}

func (HermesAdapter) Name() string { return "hermes" }
func (HermesAdapter) Install() string {
	return "https://hermes-agent.nousresearch.com/docs/getting-started/installation"
}
func (a HermesAdapter) Probe() (string, string, error) {
	return (EnvAdapter{BinaryName: "hermes", InstallHint: a.Install()}).Probe()
}
func (a HermesAdapter) Prepare(ctx LaunchContext) (Command, error) {
	if err := requireLocalClientCredential(ctx); err != nil {
		return Command{}, err
	}
	if window := ctx.ModelInfo[ctx.Model].Context; window > 0 && window < 64000 {
		return Command{}, errors.New("Hermes requires at least 64000 context tokens; select a model with a larger context window")
	}
	if hasFlag(ctx.Args, "--provider", "--api-key", "--base-url") {
		return Command{}, errors.New("rai manages Hermes provider and credentials; select the model with --model")
	}
	dir, err := clientHome(ctx.Environ, "HERMES_HOME", ".hermes")
	if err != nil {
		return Command{}, err
	}
	name := launchProviderID(ctx)
	entry := map[string]any{
		"name": name, "base_url": v1APIBase(ctx.APIBase), "api_key": ctx.APIKey,
		"api_mode": "chat_completions", "model": ctx.Model,
	}
	if info := ctx.ModelInfo[ctx.Model]; info.Context > 0 {
		entry["context_length"] = info.Context
	}
	if err := mergeHermesProvider(filepath.Join(dir, "config.yaml"), name, entry); err != nil {
		return Command{}, err
	}
	ctx.Args = append([]string{"--provider", "custom:" + name}, ctx.Args...)
	if ctx.Profile.ReasoningEffort != "" && !hasFlag(ctx.Args, "--reasoning") {
		ctx.Args = append([]string{"--reasoning", ctx.Profile.ReasoningEffort}, ctx.Args...)
	}
	return (EnvAdapter{BinaryName: "hermes", InstallHint: a.Install(), Env: openAICompatibleEnv, PassModel: true}).Prepare(ctx)
}

// Work on YAML nodes so unrelated settings and their comments survive.
func mergeHermesProvider(path, name string, entry map[string]any) error {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if entry == nil {
			return nil
		}
		raw = []byte("{}\n")
	} else if err != nil {
		return err
	}
	var doc yaml.Node
	if yaml.Unmarshal(raw, &doc) != nil || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("invalid %s; existing configuration was retained", path)
	}
	root := doc.Content[0]
	var providers *yaml.Node
	for i := 0; i < len(root.Content); i += 2 {
		if root.Content[i].Value == "custom_providers" {
			providers = root.Content[i+1]
			break
		}
	}
	if providers == nil {
		if entry == nil {
			return nil
		}
		providers = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "custom_providers"}, providers)
	}
	if providers.Kind != yaml.SequenceNode {
		return fmt.Errorf("invalid custom_providers in %s; expected a list", path)
	}
	var node yaml.Node
	if err := node.Encode(entry); err != nil && entry != nil {
		return err
	}
	replaced := false
	for i, item := range providers.Content {
		if item.Kind != yaml.MappingNode {
			continue
		}
		for j := 0; j < len(item.Content); j += 2 {
			if item.Content[j].Value == "name" && item.Content[j+1].Value == name {
				if entry == nil {
					providers.Content = append(providers.Content[:i], providers.Content[i+1:]...)
				} else {
					providers.Content[i] = &node
				}
				replaced = true
				break
			}
		}
		if replaced {
			break
		}
	}
	if !replaced {
		if entry == nil {
			return nil
		}
		providers.Content = append(providers.Content, &node)
	}
	updated, err := yaml.Marshal(&doc)
	if err != nil {
		return err
	}
	if string(raw) == string(updated) {
		return nil
	}
	return writeFileAtomic(path, updated, 0o600)
}
