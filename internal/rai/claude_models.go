package rai

import (
	"cmp"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

func claudeModelFamily(id string) string {
	id = strings.ToLower(id)
	// Preserve the gateway's original ID, including provider prefixes.
	for _, family := range []string{"sonnet", "opus", "haiku", "fable"} {
		if strings.Contains(id, "claude-"+family+"-") || strings.Contains(id, "claude-3-5-"+family+"-") || strings.Contains(id, "claude-3-7-"+family+"-") || strings.Contains(id, "claude-3-"+family+"-") {
			return family
		}
	}
	return ""
}

// ClaudeModelFamily resolves the gateway's one-hop alias before identifying
// the family. A Claude-looking alias for GPT is never advertised as Claude.
func ClaudeModelFamily(id string, info ModelInfo) string {
	return claudeModelFamily(ClaudeModelID(id, info))
}

func ClaudeModelID(id string, info ModelInfo) string {
	if info.CanonicalModel != "" {
		return info.CanonicalModel
	}
	return id
}

func CompareClaudeModels(a, b string) int { return compareClaudeModels(a, b) }

// Numeric comparison keeps 4.10 after 4.9, independent of catalog ordering.
func compareClaudeModels(a, b string) int {
	parts := func(id string) []string {
		if start := strings.Index(strings.ToLower(id), "claude-"); start >= 0 {
			id = id[start:]
		}
		return strings.FieldsFunc(id, func(r rune) bool { return !unicode.IsDigit(r) })
	}
	x, y := parts(a), parts(b)
	for i := 0; i < min(len(x), len(y)); i++ {
		xi, _ := strconv.Atoi(x[i])
		yi, _ := strconv.Atoi(y[i])
		if order := cmp.Compare(xi, yi); order != 0 {
			return order
		}
	}
	if order := cmp.Compare(len(x), len(y)); order != 0 {
		return order
	}
	return strings.Compare(a, b)
}

func claudeFamilyModel(ctx LaunchContext, family string) string {
	best := ""
	for _, id := range agentModels(ctx) {
		if ClaudeModelFamily(id, ctx.ModelInfo[id]) == family && (best == "" || compareClaudeModels(ClaudeModelID(id, ctx.ModelInfo[id]), ClaudeModelID(best, ctx.ModelInfo[best])) > 0) {
			best = id
		}
	}
	return best
}

func resolveAgentModel(agent string, profile Profile, requested string, models []string, info map[string]ModelInfo, siteDefault string) (string, error) {
	if (agent != "claude" && agent != "claude-desktop") || requested != "" {
		return resolveLaunchModel(profile, requested, models, siteDefault)
	}
	for _, id := range []string{profile.DefaultModel, siteDefault} {
		if ClaudeModelFamily(id, info[id]) != "" && slices.Contains(models, id) && agentCapable(info[id]) {
			return id, nil
		}
	}
	ctx := LaunchContext{Models: models, ModelInfo: info}
	for _, family := range []string{"sonnet", "opus", "haiku", "fable"} {
		if model := claudeFamilyModel(ctx, family); model != "" {
			return model, nil
		}
	}
	// Claude Code retains explicit support for custom gateway model IDs.
	return resolveLaunchModel(profile, requested, models, siteDefault)
}

func claudeRoleModels(ctx LaunchContext) map[string]string {
	roles := map[string]string{
		"ANTHROPIC_DEFAULT_MODEL":    ctx.Model,
		"CLAUDE_CODE_SUBAGENT_MODEL": ctx.Model,
	}
	for _, family := range []string{"haiku", "sonnet", "opus", "fable"} {
		model := claudeFamilyModel(ctx, family)
		if ClaudeModelFamily(ctx.Model, ctx.ModelInfo[ctx.Model]) == family {
			model = ctx.Model
		}
		if model == "" || ClaudeModelFamily(ctx.Model, ctx.ModelInfo[ctx.Model]) == "" {
			model = ctx.Model
		}
		roles["ANTHROPIC_DEFAULT_"+strings.ToUpper(family)+"_MODEL"] = model
	}
	return roles
}
