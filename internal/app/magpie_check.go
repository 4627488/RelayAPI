package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"
)

type magpieCheck struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

type magpieCheckResult struct {
	Checks    []magpieCheck `json:"checks"`
	Models    []string      `json:"models"`
	Model     string        `json:"model,omitempty"`
	RequestID string        `json:"request_id,omitempty"`
}

// This checks the same authenticated public handlers the local Magpie will use.
// Only an explicit generate=true spends tokens; that request is admitted, logged
// and settled normally, rather than using the administrator's unbilled probe.
func (a *App) magpieCheck(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Generate bool   `json:"generate"`
		Model    string `json:"model"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	plain, _, ok := a.magpieKey(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	result := magpieCheckResult{Models: []string{}, Checks: []magpieCheck{{Name: "key", Status: "ok", Message: "密钥有效，所属账户已启用"}}}
	call := func(method, path string, body []byte) *magpieCheckResponse {
		callCtx, callCancel := context.WithCancel(ctx)
		defer callCancel()
		request := httptest.NewRequest(method, path, bytes.NewReader(body)).WithContext(callCtx)
		request.Header.Set("Authorization", "Bearer "+plain)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", "RelayAPI-Magpie-Check")
		recorder := &magpieCheckResponse{ResponseRecorder: httptest.NewRecorder(), cancel: callCancel}
		if path == "/v1/usage" {
			a.magpieBalance(recorder, request)
		} else {
			a.handlePublic(recorder, request)
		}
		return recorder
	}
	catalog := call(http.MethodGet, "/v1/models", nil)
	var models struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if catalog.Code != 200 || catalog.truncated || json.Unmarshal(catalog.Body.Bytes(), &models) != nil {
		result.Checks = append(result.Checks, magpieCheck{Name: "models", Status: "error", Message: magpieCheckError(catalog)})
	} else {
		for _, model := range models.Data {
			if model.ID != "" {
				result.Models = append(result.Models, model.ID)
			}
		}
		status, message := "ok", "模型列表读取成功"
		if len(result.Models) == 0 {
			status, message = "error", "此密钥当前没有可用模型，请检查模型权限和订阅"
		}
		result.Checks = append(result.Checks, magpieCheck{Name: "models", Status: status, Message: message})
	}
	balance := call(http.MethodGet, "/v1/usage", nil)
	var usage magpieUsageDocument
	if balance.Code != 200 || balance.truncated || json.Unmarshal(balance.Body.Bytes(), &usage) != nil {
		result.Checks = append(result.Checks, magpieCheck{Name: "balance", Status: "error", Message: magpieCheckError(balance)})
	} else if !strings.HasPrefix(a.cfg.PublicURL, "https://") {
		result.Checks = append(result.Checks, magpieCheck{Name: "balance", Status: "skipped", Message: "额度接口可用；Magpie 自动查额度需要 HTTPS 公网地址"})
	} else {
		message := "余额与订阅摘要读取成功；复杂套餐保留各自的额度范围"
		if usage.QuotaMapping == "native" {
			message = "sub2api 原生额度窗口、处理中预留及重置时间读取成功"
		} else if usage.QuotaMapping == "cash" {
			message = "可用现金余额读取成功"
		}
		result.Checks = append(result.Checks, magpieCheck{Name: "balance", Status: "ok", Message: message})
	}
	switch {
	case !input.Generate:
		result.Checks = append(result.Checks, magpieCheck{Name: "generation", Status: "skipped", Message: "未发送生成请求；生成检查会正常计费"})
	default:
		model, err := chooseProbeModel(input.Model, result.Models)
		if err != nil {
			result.Checks = append(result.Checks, magpieCheck{Name: "generation", Status: "error", Message: "请选择此密钥模型列表中的模型"})
			break
		}
		result.Model = model
		response := call(http.MethodPost, "/v1/responses", accountProbeBody(model))
		result.RequestID = response.Header().Get("X-Relay-Request-ID")
		var terminal struct {
			Status string `json:"status"`
		}
		if response.Code >= 200 && response.Code < 300 && !response.truncated && json.Unmarshal(response.Body.Bytes(), &terminal) == nil && terminal.Status == "completed" {
			result.Checks = append(result.Checks, magpieCheck{Name: "generation", Status: "ok", Message: "Responses 生成成功；本次请求按正常规则记录并结算"})
		} else {
			result.Checks = append(result.Checks, magpieCheck{Name: "generation", Status: "error", Message: magpieCheckError(response)})
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func magpieCheckError(response *magpieCheckResponse) string {
	if response.truncated {
		return "检查响应超过 1 MiB，已取消请求；请在调用记录查看结果"
	}
	var value struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(response.Body.Bytes(), &value) == nil && value.Error.Message != "" {
		return clipProbeText(value.Error.Message)
	}
	if response.Code >= 200 && response.Code < 300 {
		return "接口未返回完成的 Responses 响应"
	}
	return "接口检查失败：" + http.StatusText(response.Code)
}

// A broken upstream must not turn a short diagnostic into an unbounded buffer.
// Cancellation still goes through the normal inference finalizer.
type magpieCheckResponse struct {
	*httptest.ResponseRecorder
	cancel    context.CancelFunc
	truncated bool
}

func (w *magpieCheckResponse) Write(p []byte) (int, error) {
	const limit = 1 << 20
	if len(p) > limit-w.Body.Len() {
		w.truncated = true
		w.cancel()
		return 0, errors.New("Magpie check response exceeds 1 MiB")
	}
	return w.ResponseRecorder.Write(p)
}

func (w *magpieCheckResponse) WriteString(value string) (int, error) {
	return w.Write([]byte(value))
}
