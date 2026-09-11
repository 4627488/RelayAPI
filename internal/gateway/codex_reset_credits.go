package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/4627488/RelayAPI/internal/egress"
)

const codexResetCreditsURL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"

// The backend contract is defined by openai/codex's backend-client rate_limit_resets.rs.
type CodexResetCredit struct {
	ID          string     `json:"id"`
	ResetType   string     `json:"reset_type"`
	Status      string     `json:"status"`
	GrantedAt   *time.Time `json:"granted_at"`
	ExpiresAt   *time.Time `json:"expires_at"`
	Title       string     `json:"title,omitempty"`
	Description string     `json:"description,omitempty"`
}

type CodexResetCredits struct {
	AvailableCount *int64             `json:"available_count"`
	Credits        []CodexResetCredit `json:"credits"`
	ObservedAt     time.Time          `json:"observed_at"`
}

type CodexResetConsumeInput struct {
	RedeemRequestID string `json:"redeem_request_id"`
	CreditID        string `json:"credit_id,omitempty"`
}

type CodexResetConsumeResult struct {
	Code         string `json:"code"`
	WindowsReset int64  `json:"windows_reset"`
}

func ReadCodexResetCredits(ctx context.Context, credential QuotaProbeCredential) (CodexResetCredits, error) {
	var result CodexResetCredits
	err := codexResetRequest(ctx, credential, nil, &result)
	if err == nil && (result.AvailableCount == nil || *result.AvailableCount < 0) {
		err = fmt.Errorf("Codex 未返回有效的 banked resets 次数")
	}
	result.ObservedAt = time.Now().UTC()
	return result, err
}

func ConsumeCodexResetCredit(ctx context.Context, credential QuotaProbeCredential, input CodexResetConsumeInput) (CodexResetConsumeResult, error) {
	var result CodexResetConsumeResult
	if strings.TrimSpace(input.RedeemRequestID) == "" {
		return result, fmt.Errorf("redeem_request_id is required")
	}
	err := codexResetRequest(ctx, credential, &input, &result)
	if err == nil {
		switch result.Code {
		case "reset", "already_redeemed", "nothing_to_reset", "no_credit":
		default:
			err = fmt.Errorf("Codex 返回未知重置结果；请使用同一请求标识重试")
		}
	}
	return result, err
}

func codexResetRequest(ctx context.Context, credential QuotaProbeCredential, input *CodexResetConsumeInput, result any) error {
	if credential.Provider != "codex" {
		return fmt.Errorf("banked resets 仅支持 Codex OAuth 账户")
	}
	var document map[string]any
	if err := json.Unmarshal(credential.Document, &document); err != nil {
		return fmt.Errorf("invalid Codex credential")
	}
	token := scalarQuotaText(document["access_token"])
	accountID := firstQuotaText(scalarQuotaText(document["account_id"]), scalarQuotaText(document["chatgpt_account_id"]), scalarQuotaText(document["organization_id"]))
	if token == "" || accountID == "" {
		return fmt.Errorf("Codex 登录凭据不完整，请重新授权")
	}
	client, err := egress.OutboundHTTPClient(credential.ProxyURL, 25*time.Second)
	if err != nil {
		return err
	}
	return requestCodexResetCredits(ctx, client, codexResetCreditsURL, codexQuotaHeaders(token, accountID), input, result)
}

func requestCodexResetCredits(ctx context.Context, client *http.Client, endpoint string, headers http.Header, input *CodexResetConsumeInput, result any) error {
	method := http.MethodGet
	var body io.Reader
	if input != nil {
		method = http.MethodPost
		endpoint += "/consume"
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header = headers.Clone()
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Codex banked resets 请求失败，请重试")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// Do not send upstream response bodies or credential material to the browser.
		return fmt.Errorf("Codex banked resets returned HTTP %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxQuotaResponseBytes)).Decode(result); err != nil {
		return fmt.Errorf("Codex banked resets 返回的数据格式无效")
	}
	return nil
}
