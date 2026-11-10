package rai

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
)

// A stable UUID lets configure and unconfigure find rai's own library entry
// without taking over another profile or depending on the current selection.
const claudeDesktopProfileID = "f25cf69c-d996-5e83-a759-ec347e583971"

func validateClaudeSearchURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return errors.New("--web-search-url must be an HTTP(S) endpoint without credentials, query parameters or fragments")
	}
	return nil
}

func validateClaudeDesktopFiles(files []*clientConfigFile) error {
	for _, file := range files {
		if file.Raw != nil && !json.Valid(file.Raw) {
			return fmt.Errorf("invalid Claude Desktop JSON at %s; existing file was retained", file.Path)
		}
	}
	_, err := desktopLibraryEntries(files[1].Document)
	return err
}

func claudeDesktopHome(environ []string, platform string) (string, error) {
	if explicit := environmentValue(environ, "CLAUDE_USER_DATA_DIR"); explicit != "" {
		return filepath.Abs(explicit)
	}
	switch platform {
	case "darwin":
		return clientHome(environ, "", "Library/Application Support/Claude-3p")
	case "windows":
		base, err := clientHome(environ, "LOCALAPPDATA", "AppData/Local")
		return filepath.Join(base, "Claude-3p"), err
	default:
		base, err := clientHome(environ, "XDG_CONFIG_HOME", ".config")
		return filepath.Join(base, "Claude-3p"), err
	}
}

func claudeDesktopConfigTargets(environ []string) ([]clientConfigTarget, error) {
	dir, err := claudeDesktopHome(environ, runtime.GOOS)
	if err != nil {
		return nil, err
	}
	// Install the profile before selecting it. saveClientConfig journals all
	// three files and rolls them back together on a failed write.
	return []clientConfigTarget{
		{filepath.Join(dir, "configLibrary", claudeDesktopProfileID+".json"), "json"},
		{filepath.Join(dir, "configLibrary", "_meta.json"), "json"},
		{filepath.Join(dir, "claude_desktop_config.json"), "json"},
	}, nil
}

func desktopLibraryEntries(doc map[string]any) ([]any, error) {
	raw, exists := doc["entries"]
	if !exists {
		if len(doc) != 0 {
			return nil, errors.New("Claude Desktop config library is missing entries; existing metadata was retained")
		}
		return nil, nil
	}
	entries, ok := raw.([]any)
	if !ok {
		return nil, errors.New("Claude Desktop config library entries must be a list")
	}
	seen := map[string]bool{}
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		id, idOK := entry["id"].(string)
		_, nameOK := entry["name"].(string)
		if !ok || !idOK || id == "" || !nameOK || seen[id] {
			return nil, errors.New("invalid Claude Desktop config library entry; existing metadata was retained")
		}
		seen[id] = true
	}
	if selected, exists := doc["appliedId"]; exists {
		id, ok := selected.(string)
		if !ok || (id != "" && !seen[id]) {
			return nil, errors.New("Claude Desktop selected config is absent from its library; existing metadata was retained")
		}
	}
	return entries, nil
}

func buildClaudeDesktopConfig(ctx LaunchContext, files []*clientConfigFile) error {
	if ClaudeModelFamily(ctx.Model, ctx.ModelInfo[ctx.Model]) == "" || !slices.Contains(ctx.Models, ctx.Model) || !agentCapable(ctx.ModelInfo[ctx.Model]) {
		return errors.New("Claude Desktop requires an authorized Claude model; select one with --model")
	}
	entries, err := desktopLibraryEntries(files[1].Document)
	if err != nil {
		return err
	}
	auth, err := codexAuth(ctx.Profile, ctx.RAIHome, ctx.RAI)
	if err != nil {
		return err
	}
	base := ctx.APIBase
	if base == "" {
		base = ctx.Profile.ServerURL
	}
	settings := map[string]any{
		"inferenceProvider":                             "gateway",
		"inferenceGatewayBaseUrl":                       strings.TrimRight(base, "/"),
		"inferenceGatewayAuthScheme":                    "bearer",
		"inferenceCredentialKind":                       "helper-script",
		"inferenceCredentialHelper":                     auth["command"],
		"inferenceCredentialHelperArgs":                 auth["args"],
		"inferenceCredentialHelperTimeoutSec":           codexAuthTimeoutMS / 1000,
		"inferenceCredentialHelperTtlSec":               codexAuthRefreshMS / 1000,
		"inferenceCredentialHelperSilentRefreshEnabled": true,
		"modelDiscoveryEnabled":                         false,
		"toolSearchEnabled":                             ctx.ModelInfo[ctx.Model].ToolSearch != nil && *ctx.ModelInfo[ctx.Model].ToolSearch,
		"inferenceGatewayAutoModeServerChecks":          false,
	}
	// The first entry is the initial model; only authorized, tool-capable
	// Claude IDs belong in Desktop's model picker. Preserve gateway IDs.
	models := []any{}
	roles := claudeRoleModels(ctx)
	ids := append([]string{ctx.Model}, agentModels(ctx)...)
	seen := map[string]bool{}
	for _, id := range ids {
		info := ctx.ModelInfo[id]
		family := ClaudeModelFamily(id, info)
		if seen[id] || family == "" {
			continue
		}
		seen[id] = true
		entry := map[string]any{"name": id, "anthropicFamilyTier": family}
		canonical := ClaudeModelID(id, info)
		if canonical != id {
			entry["behavesAs"] = canonical
		}
		// A fact sheet may describe a window larger than this deployment's
		// input allowance. Never advertise 1M using the former alone.
		window := info.Context
		if info.MaxInput > 0 && (window == 0 || info.MaxInput < window) {
			window = info.MaxInput
		}
		if window >= 1000000 {
			entry["supports1m"] = true
		}
		if roles["ANTHROPIC_DEFAULT_"+strings.ToUpper(family)+"_MODEL"] == id {
			entry["isFamilyDefault"] = true
		}
		models = append(models, entry)
	}
	settings["inferenceModels"] = models
	if ctx.ClaudeDiscovery {
		settings["modelDiscoveryEnabled"] = true
		delete(settings, "inferenceModels")
		delete(files[0].Document, "inferenceModels")
	}
	if level := ctx.Profile.ReasoningEffort; level != "" {
		switch level {
		case "minimal":
			level = "low"
		case "ultra":
			level = "max"
		case "none":
			return errors.New("Claude Desktop does not support reasoning effort none; choose low, medium, high, xhigh or max")
		}
		settings["defaultModelEffort"] = level
	}
	for _, key := range []string{"inferenceGatewayApiKey", "inferenceGatewayOidc", "inferenceIdpOidc", "inferenceCustomHeaders", "defaultModelEffort"} {
		delete(files[0].Document, key)
	}
	for key, value := range settings {
		files[0].Document[key] = value
	}
	if ctx.ClaudeSearchURL != "" {
		if err := configureClaudeSearch(files[0].Document, ctx.ClaudeSearchURL); err != nil {
			return err
		}
	}
	entry := map[string]any{"id": claudeDesktopProfileID, "name": fmt.Sprintf("RelayAPI (%s)", ctx.Profile.Name)}
	found := false
	for i, raw := range entries {
		if raw.(map[string]any)["id"] == claudeDesktopProfileID {
			entries[i], found = entry, true
		}
	}
	if !found {
		entries = append(entries, entry)
	}
	files[1].Document["entries"] = entries
	files[1].Document["appliedId"] = claudeDesktopProfileID
	delete(files[1].Document, "hybridPointer")
	files[2].Document["deploymentMode"] = "3p"
	return nil
}

func configureClaudeSearch(doc map[string]any, endpoint string) error {
	if err := validateClaudeSearchURL(endpoint); err != nil {
		return err
	}
	var servers []any
	if raw, exists := doc["managedMcpServers"]; exists {
		var ok bool
		servers, ok = raw.([]any)
		if !ok {
			return errors.New("Claude Desktop managedMcpServers must be a list")
		}
	}
	for i, raw := range servers {
		entry, ok := raw.(map[string]any)
		if !ok {
			return errors.New("invalid Claude Desktop MCP server")
		}
		if entry["name"] == "RelayAPI web search" && entry["server"] != "websearch" {
			return errors.New("Claude Desktop MCP name RelayAPI web search is already in use")
		}
		if entry["server"] == "websearch" {
			// Do not attach a previous vendor's credentials to a new search URL.
			if entry["provider"] != "custom" || entry["customUrl"] != endpoint {
				return errors.New("a different Desktop web search provider is configured; change it in Desktop before using --web-search-url")
			}
			servers[i] = entry
			doc["managedMcpServers"] = servers
			return nil
		}
	}
	servers = append(servers, map[string]any{"name": "RelayAPI web search", "server": "websearch", "provider": "custom", "customUrl": endpoint, "toolPolicy": map[string]any{"web_search": "allow"}})
	doc["managedMcpServers"] = servers
	return nil
}

// Library entries are keyed by UUID, so a new user profile must survive
// unconfigure even when it was added after rai selected its own profile.
func restoreDesktopLibraryEntries(current, before, after map[string]any) {
	installed, ok := after["entries"].([]any)
	if !ok {
		return
	}
	find := func(entries []any) (any, bool) {
		for _, value := range entries {
			if entry, ok := value.(map[string]any); ok && entry["id"] == claudeDesktopProfileID {
				return value, true
			}
		}
		return nil, false
	}
	added, ours := find(installed)
	if !ours {
		return
	}
	entries, valid := current["entries"].([]any)
	if !valid {
		delete(before, "entries")
		delete(after, "entries")
		return
	}
	original, _ := before["entries"].([]any)
	old, existed := find(original)
	updated := []any{}
	for _, value := range entries {
		entry, _ := value.(map[string]any)
		if entry["id"] != claudeDesktopProfileID || (existed && !reflect.DeepEqual(value, added)) {
			updated = append(updated, value)
		} else if existed {
			updated = append(updated, old)
		}
	}
	if len(updated) == 0 && before["entries"] == nil {
		delete(current, "entries")
	} else {
		current["entries"] = updated
	}
	// The user may have removed the old active profile while rai was selected.
	// Restore a live entry rather than leaving a pointer to a removed UUID.
	if current["appliedId"] == claudeDesktopProfileID {
		previous := before["appliedId"]
		found := false
		for _, value := range updated {
			entry, _ := value.(map[string]any)
			found = found || entry["id"] == previous
		}
		if !found {
			delete(before, "appliedId")
			delete(before, "hybridPointer")
			if len(updated) > 0 {
				before["appliedId"] = updated[0].(map[string]any)["id"]
			}
		}
	}
	delete(before, "entries")
	delete(after, "entries")
}
