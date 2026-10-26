package rai

// ModelInfo contains optional server facts, not access grants. Models remains
// the authoritative list of IDs allowed for this credential. Older servers may
// omit this map; adapters then leave optional client settings unspecified.
type ModelInfo struct {
	Name             string   `json:"name,omitempty"`
	Context          int      `json:"context,omitempty"`
	MaxInput         int      `json:"max_input,omitempty"`
	MaxOutput        int      `json:"max_output,omitempty"`
	ToolCall         *bool    `json:"tool_call,omitempty"`
	Reasoning        *bool    `json:"reasoning,omitempty"`
	ReasoningLevels  []string `json:"reasoning_levels,omitempty"`
	InputModalities  []string `json:"input_modalities,omitempty"`
	OutputModalities []string `json:"output_modalities,omitempty"`
}

func agentModels(ctx LaunchContext) []string {
	models := ctx.Models
	if len(models) == 0 && ctx.Model != "" {
		models = []string{ctx.Model}
	}
	result := make([]string, 0, len(models))
	for _, id := range models {
		info := ctx.ModelInfo[id]
		if !agentCapable(info) {
			continue
		}
		result = append(result, id)
	}
	return result
}

func agentCapable(info ModelInfo) bool {
	return (info.ToolCall == nil || *info.ToolCall) && (len(info.OutputModalities) == 0 || contains(info.OutputModalities, "text"))
}
