package rai

import (
	"regexp"
	"strings"
)

var (
	relayKeyPattern = regexp.MustCompile(`relay_[A-Za-z0-9_-]+`)
	bearerPattern   = regexp.MustCompile(`(?i)(authorization:\s*bearer\s+)(\S+)`)
)

func redact(value string) string {
	value = relayKeyPattern.ReplaceAllString(value, "relay_***")
	value = bearerPattern.ReplaceAllString(value, "${1}***")
	return value
}

func keyPrefix(plain string) string {
	plain = strings.TrimSpace(plain)
	if len(plain) <= 10 {
		return "relay_***"
	}
	return plain[:10] + "…"
}
