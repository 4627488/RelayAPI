package upstream

import (
	"fmt"
	"strings"
	"time"
)

func anyString(value any) string       { text, _ := value.(string); return strings.TrimSpace(text) }
func generatedID(prefix string) string { return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano()) }
func asAnySlice(value any) []any       { v, _ := value.([]any); return v }

func appendUniqueRoute(ids []string, id string) []string {
	for _, v := range ids {
		if v == id {
			return ids
		}
	}
	return append(ids, id)
}
