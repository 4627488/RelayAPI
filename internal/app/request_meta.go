package app

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/tidwall/gjson"
)

type requestMeta struct {
	Model           string `json:"model"`
	Stream          bool   `json:"stream"`
	ServiceTier     string `json:"service_tier"`
	ReasoningEffort string `json:"reasoning_effort"`
	ImageCount      int    `json:"n"`
	RequestedModel  string `json:"-"`
	ModelAlias      string `json:"-"`
}

func readRequestMeta(body []byte, _ string) requestMeta {
	values := gjson.GetManyBytes(body, "model", "stream", "service_tier", "reasoning_effort", "reasoning.effort", "n")
	meta := requestMeta{
		Model:           strings.TrimSpace(values[0].String()),
		Stream:          values[1].Bool(),
		ServiceTier:     strings.TrimSpace(values[2].String()),
		ReasoningEffort: strings.TrimSpace(values[3].String()),
		ImageCount:      int(values[5].Int()),
	}
	if meta.ReasoningEffort == "" {
		meta.ReasoningEffort = strings.TrimSpace(values[4].String())
	}
	return meta
}

func requestMetadata(body []byte, r *http.Request) requestMeta {
	meta := readRequestMeta(body, r.URL.Path)
	if meta.Model == "" {
		meta = readFormRequestMeta(body, r.Header.Get("Content-Type"), meta)
	}
	if meta.Model == "" {
		meta.Model = strings.TrimSpace(r.URL.Query().Get("model"))
	}
	if isWebSocketUpgrade(r) {
		meta.Stream = true
	}
	return meta
}

func readFormRequestMeta(body []byte, contentType string, meta requestMeta) requestMeta {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return meta
	}
	switch mediaType {
	case "application/x-www-form-urlencoded":
		values, parseErr := url.ParseQuery(string(body))
		if parseErr == nil {
			meta.Model = strings.TrimSpace(values.Get("model"))
			meta.Stream, _ = strconv.ParseBool(values.Get("stream"))
			meta.ImageCount, _ = strconv.Atoi(values.Get("n"))
		}
	case "multipart/form-data":
		boundary := strings.TrimSpace(params["boundary"])
		if boundary == "" {
			return meta
		}
		reader := multipart.NewReader(bytes.NewReader(body), boundary)
		for {
			part, partErr := reader.NextPart()
			if partErr != nil {
				break
			}
			name := part.FormName()
			if part.FileName() != "" || (name != "model" && name != "stream" && name != "n") {
				_ = part.Close()
				continue
			}
			value, _ := io.ReadAll(io.LimitReader(part, 4<<10))
			_ = part.Close()
			switch name {
			case "model":
				meta.Model = strings.TrimSpace(string(value))
			case "stream":
				meta.Stream, _ = strconv.ParseBool(strings.TrimSpace(string(value)))
			case "n":
				meta.ImageCount, _ = strconv.Atoi(strings.TrimSpace(string(value)))
			}
		}
	}
	return meta
}

func resolveAPIKeyModel(requested string, aliases []store.APIKeyModelAlias) requestMeta {
	requested = strings.TrimSpace(requested)
	result := requestMeta{Model: requested, RequestedModel: requested}
	for _, item := range aliases {
		if strings.EqualFold(strings.TrimSpace(item.Alias), requested) {
			result.Model = strings.TrimSpace(item.Model)
			result.ModelAlias = requested
			break
		}
	}
	return result
}

func rewriteRequestModel(body []byte, requestURL *url.URL, requested, actual string) ([]byte, error) {
	if requested == "" || actual == "" || strings.EqualFold(requested, actual) {
		return body, nil
	}
	if result := gjson.GetBytes(body, "model"); result.Type == gjson.String && result.Index > 0 &&
		strings.EqualFold(strings.TrimSpace(result.String()), requested) {
		replacement, _ := json.Marshal(actual)
		end := result.Index + len(result.Raw)
		if end <= len(body) {
			rewritten := make([]byte, len(body)-len(result.Raw)+len(replacement))
			at := copy(rewritten, body[:result.Index])
			at += copy(rewritten[at:], replacement)
			copy(rewritten[at:], body[end:])
			body = rewritten
		}
	}
	query := requestURL.Query()
	if strings.EqualFold(strings.TrimSpace(query.Get("model")), requested) {
		query.Set("model", actual)
		requestURL.RawQuery = query.Encode()
	}
	return body, nil
}

func readBoundedRequestBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	reader := http.MaxBytesReader(w, r.Body, limit)
	var buffer bytes.Buffer
	// io.ReadAll grows geometrically without knowing the HTTP content length.
	// Large JSON requests are common here, so reserve the exact known size and
	// avoid retaining a substantially oversized backing array.
	if r.ContentLength > 0 && r.ContentLength <= limit {
		buffer.Grow(int(r.ContentLength))
	}
	_, err := buffer.ReadFrom(reader)
	return buffer.Bytes(), err
}
