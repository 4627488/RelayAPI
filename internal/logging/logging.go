// Package logging configures the process log stream consumed by Alloy/Loki.
package logging

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

// Configure keeps network delivery out of request handlers. The collector owns
// buffering/retries; stdout remains available when Loki is unreachable.
func Configure(w io.Writer, value string) error {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("RELAY_LOG_LEVEL must be debug, info, warn or error")
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(value)); err != nil {
		return fmt.Errorf("RELAY_LOG_LEVEL must be debug, info, warn or error")
	}
	slog.SetDefault(slog.New(handler(w, level)).With("service", "relayapi"))
	logrus.SetOutput(w)
	logrus.SetFormatter(legacyFormatter{})
	switch {
	case level >= slog.LevelError:
		logrus.SetLevel(logrus.ErrorLevel)
	case level >= slog.LevelWarn:
		logrus.SetLevel(logrus.WarnLevel)
	case level >= slog.LevelInfo:
		logrus.SetLevel(logrus.InfoLevel)
	default:
		logrus.SetLevel(logrus.DebugLevel)
	}
	return nil
}

func handler(w io.Writer, level slog.Level) slog.Handler {
	return slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level, ReplaceAttr: sanitize})
}

var (
	urlPattern    = regexp.MustCompile(`(?i)(?:https?|postgres(?:ql)?)://[^\s"<>]+`)
	secretPattern = regexp.MustCompile(`(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)["']?\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s,"';}]+`)
	bearerPattern = regexp.MustCompile(`(?i)(Bearer\s+)[^\s,"';}]+`)
	keyPattern    = regexp.MustCompile(`\b(?:sk-|relay_)[A-Za-z0-9_-]+`)
)

func clean(value string) string {
	value = urlPattern.ReplaceAllStringFunc(value, func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			return "[REDACTED_URL]"
		}
		u.User, u.RawQuery, u.Fragment = nil, "", ""
		return u.String()
	})
	value = bearerPattern.ReplaceAllString(value, "${1}[REDACTED]")
	value = secretPattern.ReplaceAllString(value, "${1}[REDACTED]")
	value = keyPattern.ReplaceAllString(value, "[REDACTED]")
	const limit = 4096
	if len(value) > limit {
		value = strings.ToValidUTF8(value[:limit], "") + "…[truncated]"
	}
	return value
}

func sanitize(_ []string, attr slog.Attr) slog.Attr {
	if level, ok := attr.Value.Any().(slog.Level); ok {
		return slog.String(attr.Key, level.String())
	}
	key := strings.ToLower(strings.ReplaceAll(attr.Key, "-", "_"))
	switch key {
	case "authorization", "proxy_authorization", "cookie", "set_cookie", "api_key", "x_api_key", "token", "access_token", "refresh_token", "password", "secret", "client_secret", "database_url", "request_body", "response_body", "upstream_body", "forwarded_body", "headers":
		return slog.String(attr.Key, "[REDACTED]")
	}
	if attr.Value.Kind() == slog.KindString {
		attr.Value = slog.StringValue(clean(attr.Value.String()))
	} else if attr.Value.Kind() == slog.KindAny {
		// Never serialize arbitrary upstream objects (which may contain credentials).
		if err, ok := attr.Value.Any().(error); ok {
			attr.Value = slog.StringValue(clean(err.Error()))
		} else if attr.Value.Any() != nil {
			attr.Value = slog.StringValue("[OMITTED]")
		}
	}
	return attr
}

// CPA uses logrus; normalize it to the same schema and redaction policy.
type legacyFormatter struct{}

func (legacyFormatter) Format(entry *logrus.Entry) ([]byte, error) {
	var buf bytes.Buffer
	level := slog.LevelInfo
	switch entry.Level {
	case logrus.PanicLevel, logrus.FatalLevel, logrus.ErrorLevel:
		level = slog.LevelError
	case logrus.WarnLevel:
		level = slog.LevelWarn
	case logrus.DebugLevel, logrus.TraceLevel:
		level = slog.LevelDebug
	}
	at := entry.Time
	if at.IsZero() {
		at = time.Now()
	}
	record := slog.NewRecord(at, level, entry.Message, 0)
	record.AddAttrs(slog.String("service", "relayapi"), slog.String("component", "cpa"))
	for key, value := range entry.Data {
		record.AddAttrs(slog.Any(key, value))
	}
	err := handler(&buf, slog.LevelDebug).Handle(context.Background(), record)
	return buf.Bytes(), err
}
