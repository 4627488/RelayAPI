"use client";

import * as React from "react";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";

import {
  ApiKeyBaseFields,
  EMPTY_API_KEY_FORM,
  apiKeyFormToPayload,
  apiKeyToForm,
  assertApiKey,
  parseList,
  type ApiKeyFormState,
} from "@/components/workspace/api-key-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import {
  createTenantApiKey,
  tenantErrorMessage,
  updateTenantApiKey,
} from "@/lib/tenant-api";
import type {
  CreatedApiKey,
  PublicApiKey,
  TenantResources,
} from "@/src/shared/types/entities";

export function TenantApiKeyDialog({
  apiKey,
  mode,
  onOpenChange,
  onSaved,
  open,
  resources,
}: {
  apiKey?: PublicApiKey | null;
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSaved: (apiKey: PublicApiKey | CreatedApiKey) => void;
  open: boolean;
  resources: TenantResources;
}) {
  const [form, setForm] = React.useState<ApiKeyFormState>(() =>
    apiKey ? apiKeyToForm(apiKey) : EMPTY_API_KEY_FORM,
  );
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const payload = apiKeyFormToPayload(form);
      const saved =
        mode === "create"
          ? await createTenantApiKey(payload)
          : await updateTenantApiKey(assertApiKey(apiKey).id, payload);
      onSaved(saved);
      onOpenChange(false);
      toast.success(mode === "create" ? "API 密钥已创建" : "API 密钥已保存");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {mode === "create" ? "新建租户 API 密钥" : "编辑租户 API 密钥"}
            </DialogTitle>
            <DialogDescription>
              模型和通道只能从管理员授权范围内选择。
            </DialogDescription>
          </DialogHeader>
          <FieldSet>
            <FieldLegend>密钥配置</FieldLegend>
            <ApiKeyBaseFields
              form={form}
              modelOptions={resources.models}
              onChange={setForm}
              channelSelector={
                <TenantChannelSelector
                  resources={resources}
                  selectedIds={parseList(form.channelAllowlist)}
                  onSelectedIdsChange={(ids) =>
                    setForm((current) => ({
                      ...current,
                      channelAllowlist: ids.join("\n"),
                    }))
                  }
                />
              }
            />
          </FieldSet>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {mode === "create" ? "创建密钥" : "保存配置"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CreatedApiKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: CreatedApiKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  async function copyKey() {
    if (!apiKey?.key) {
      return;
    }
    await navigator.clipboard.writeText(apiKey.key);
    toast.success("密钥已复制");
  }

  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>保存 API 密钥明文</DialogTitle>
          <DialogDescription>密钥明文只会显示这一次。</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/50 p-3 font-mono text-sm break-all">
          {apiKey?.key}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={copyKey}>
            <CopyIcon data-icon="inline-start" />
            复制
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TenantChannelSelector({
  onSelectedIdsChange,
  resources,
  selectedIds,
}: {
  resources: TenantResources;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const selected = new Set(selectedIds);
  if (resources.channels.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无授权通道。</p>;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {resources.channels.map((channel) => {
        const active = selected.has(channel.id);
        return (
          <Button
            key={channel.id}
            type="button"
            variant={active ? "secondary" : "outline"}
            className="h-auto justify-start"
            onClick={() =>
              onSelectedIdsChange(
                active
                  ? selectedIds.filter((id) => id !== channel.id)
                  : [...selectedIds, channel.id],
              )
            }
          >
            <span className="truncate">{channel.name}</span>
          </Button>
        );
      })}
    </div>
  );
}
