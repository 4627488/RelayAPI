"use client";

import * as React from "react";

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector, stripThinkingLevel } from "@/components/workspace/model-selector";
import {
  datetimeLocalToIso,
  toDatetimeLocal,
} from "@/components/workspace/format";
import type { ApiKeyPayload } from "@/lib/admin-api";
import type { PublicApiKey } from "@/src/shared/types/entities";

export type ApiKeyFormState = {
  name: string;
  enabled: boolean;
  scopes: string;
  modelAllowlist: string;
  channelAllowlist: string;
  tokenLimitDaily: string;
  rateLimitPerMinute: string;
  expiresAt: string;
};

export const EMPTY_API_KEY_FORM: ApiKeyFormState = {
  name: "",
  enabled: true,
  scopes: "relay",
  modelAllowlist: "",
  channelAllowlist: "",
  tokenLimitDaily: "",
  rateLimitPerMinute: "",
  expiresAt: "",
};

export function ApiKeyBaseFields({
  channelSelector,
  form,
  modelOptions,
  onChange,
}: {
  channelSelector: React.ReactNode;
  form: ApiKeyFormState;
  modelOptions?: string[];
  onChange: React.Dispatch<React.SetStateAction<ApiKeyFormState>>;
}) {
  const update = <K extends keyof ApiKeyFormState>(
    key: K,
    value: ApiKeyFormState[K],
  ) => onChange((current) => ({ ...current, [key]: value }));

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="api-key-name">名称</FieldLabel>
        <Input
          id="api-key-name"
          value={form.name}
          onChange={(event) => update("name", event.target.value)}
        />
      </Field>
      <Field orientation="horizontal">
        <div>
          <FieldLabel htmlFor="api-key-enabled">启用密钥</FieldLabel>
          <FieldDescription>
            关闭后，客户端会立即无法使用这个 Key。
          </FieldDescription>
        </div>
        <Switch
          id="api-key-enabled"
          checked={form.enabled}
          onCheckedChange={(checked) => update("enabled", Boolean(checked))}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="api-key-token-limit">每日 token 上限</FieldLabel>
          <Input
            id="api-key-token-limit"
            inputMode="numeric"
            placeholder="留空表示不限制"
            value={form.tokenLimitDaily}
            onChange={(event) => update("tokenLimitDaily", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="api-key-rate-limit">每分钟请求限制</FieldLabel>
          <Input
            id="api-key-rate-limit"
            inputMode="numeric"
            placeholder="留空表示不限制"
            value={form.rateLimitPerMinute}
            onChange={(event) =>
              update("rateLimitPerMinute", event.target.value)
            }
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="api-key-expires-at">过期时间</FieldLabel>
        <Input
          id="api-key-expires-at"
          type="datetime-local"
          value={form.expiresAt}
          onChange={(event) => update("expiresAt", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="api-key-scopes">权限范围</FieldLabel>
        <Textarea
          id="api-key-scopes"
          value={form.scopes}
          onChange={(event) => update("scopes", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel>模型白名单</FieldLabel>
        <ModelSelector
          models={modelOptions}
          selectedModels={parseList(form.modelAllowlist)}
          onSelectedModelsChange={(models) => update("modelAllowlist", models.join("\n"))}
        />
      </Field>
      <Field>
        <FieldLabel>通道白名单</FieldLabel>
        {channelSelector}
        <FieldDescription>不选任何通道表示使用全部授权通道。</FieldDescription>
      </Field>
    </FieldGroup>
  );
}

export function apiKeyToForm(apiKey: PublicApiKey): ApiKeyFormState {
  return {
    name: apiKey.name,
    enabled: apiKey.enabled,
    scopes: apiKey.scopes.join("\n") || "relay",
    modelAllowlist: apiKey.modelAllowlist.join("\n"),
    channelAllowlist: apiKey.channelAllowlist.join("\n"),
    tokenLimitDaily: apiKey.tokenLimitDaily?.toString() || "",
    rateLimitPerMinute: apiKey.rateLimitPerMinute?.toString() || "",
    expiresAt: toDatetimeLocal(apiKey.expiresAt),
  };
}

export function apiKeyFormToPayload(
  form: ApiKeyFormState,
  options: { fallbackName?: string } = {},
): ApiKeyPayload {
  const scopes = parseList(form.scopes);
  return {
    name: form.name.trim() || options.fallbackName,
    enabled: form.enabled,
    scopes: scopes.length > 0 ? scopes : ["relay"],
    modelAllowlist: normalizeModelList(form.modelAllowlist),
    channelAllowlist: parseList(form.channelAllowlist),
    tokenLimitDaily: nullablePositiveInteger(form.tokenLimitDaily),
    rateLimitPerMinute: nullablePositiveInteger(form.rateLimitPerMinute),
    expiresAt: datetimeLocalToIso(form.expiresAt),
  };
}

function normalizeModelList(value: string) {
  return [...new Set(parseList(value).map(stripThinkingLevel).filter(Boolean))];
}

export function assertApiKey(apiKey: PublicApiKey | null | undefined) {
  if (!apiKey) {
    throw new Error("API key is required");
  }
  return apiKey;
}

export function parseList(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function nullablePositiveInteger(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}
