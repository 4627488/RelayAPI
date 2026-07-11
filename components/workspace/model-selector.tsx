"use client";

import * as React from "react";

import { CheckCircle2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function ModelSelector({
  models = [],
  onSelectedModelsChange,
  selectedModels,
}: {
  models?: string[];
  onSelectedModelsChange: (models: string[]) => void;
  selectedModels: string[];
}) {
  const [catalogModels, setCatalogModels] = React.useState<string[]>(models);
  const [loading, setLoading] = React.useState(models.length === 0);

  React.useEffect(() => {
    let cancelled = false;
    void fetch("/api/model-catalog", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("model catalog unavailable");
        return response.json() as Promise<{ data?: string[] }>;
      })
      .then((result) => {
        if (!cancelled && Array.isArray(result.data)) setCatalogModels(result.data);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const normalizedModels = [...models, ...catalogModels].map(stripThinkingLevel);
  const normalizedSelectedModels = selectedModels.map(stripThinkingLevel);
  const options = [...new Set([...normalizedModels, ...normalizedSelectedModels])].filter(Boolean);
  const selected = new Set(normalizedSelectedModels);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {loading ? "正在同步上游模型目录…" : "不选择表示允许全部模型"}
        </span>
        {normalizedSelectedModels.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onSelectedModelsChange([])}>
            清空选择
          </Button>
        )}
      </div>
      <div className="grid max-h-72 gap-2 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((model) => {
          const active = selected.has(model);
          return (
            <Button
              key={model}
              type="button"
              variant={active ? "secondary" : "outline"}
              className="h-auto justify-between font-mono"
              onClick={() => onSelectedModelsChange(active ? normalizedSelectedModels.filter((item) => item !== model) : [...normalizedSelectedModels, model])}
            >
              <span className="truncate">{model}</span>
              {active ? <CheckCircle2Icon /> : <Badge variant="outline">可选</Badge>}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function stripThinkingLevel(model: string) {
  return String(model || "").trim().replace(/\((?:low|medium|high|xhigh)\)$/i, "");
}
