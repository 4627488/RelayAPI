package dataplane

import (
	"context"
	"fmt"

	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/translator/builtin"
)

// Translator is a narrow, versioned boundary around CPA's built-in protocol
// matrix. No CPA server, router, credential manager or billing code is used.
type Translator struct {
	registry *sdktranslator.Registry
}

func NewTranslator() *Translator {
	return &Translator{registry: builtin.Registry()}
}

func (t *Translator) TranslateRequest(from, to Protocol, model string, body []byte, stream bool) ([]byte, error) {
	if from == to {
		return body, nil
	}
	if t == nil || t.registry == nil || !t.registry.HasRequestTransformer(format(from), format(to)) {
		return nil, fmt.Errorf("request translation %s -> %s is unavailable", from, to)
	}
	return t.registry.TranslateRequest(format(from), format(to), model, body, stream), nil
}

type StreamState struct {
	value any
}

func (t *Translator) TranslateStreamLine(ctx context.Context, inbound, upstream Protocol, model string, originalRequest, translatedRequest, line []byte, state *StreamState) ([][]byte, error) {
	if inbound == upstream {
		return [][]byte{line}, nil
	}
	// CPA registers each response transform under the same (client, provider)
	// pair as its request transform, but TranslateStream accepts the actual byte
	// direction (provider, client). Keep that asymmetry contained here.
	if t == nil || t.registry == nil || !t.registry.HasStreamResponseTransformer(format(inbound), format(upstream)) {
		return nil, fmt.Errorf("stream translation %s -> %s -> %s is unavailable", inbound, upstream, inbound)
	}
	if state == nil {
		state = &StreamState{}
	}
	return t.registry.TranslateStream(ctx, format(upstream), format(inbound), model, originalRequest, translatedRequest, line, &state.value), nil
}

func (t *Translator) TranslateResponse(ctx context.Context, inbound, upstream Protocol, model string, originalRequest, translatedRequest, body []byte) ([]byte, error) {
	if inbound == upstream {
		return body, nil
	}
	if t == nil || t.registry == nil || !t.registry.HasNonStreamResponseTransformer(format(inbound), format(upstream)) {
		return nil, fmt.Errorf("response translation %s -> %s -> %s is unavailable", inbound, upstream, inbound)
	}
	var state any
	return t.registry.TranslateNonStream(ctx, format(upstream), format(inbound), model, originalRequest, translatedRequest, body, &state), nil
}

func (t *Translator) Supports(from, to Protocol, stream bool) bool {
	if from == to {
		return true
	}
	if t == nil || t.registry == nil || !t.registry.HasRequestTransformer(format(from), format(to)) {
		return false
	}
	if stream {
		return t.registry.HasStreamResponseTransformer(format(from), format(to))
	}
	return t.registry.HasNonStreamResponseTransformer(format(from), format(to))
}

func format(protocol Protocol) sdktranslator.Format {
	return sdktranslator.Format(protocol)
}
