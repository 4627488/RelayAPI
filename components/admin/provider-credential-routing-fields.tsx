import type { ReactNode } from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function ProviderCredentialRoutingFields({
  action,
  credentialId,
  disabled = false,
  enabled,
  onEnabledChange,
  onPriorityChange,
  onWeightChange,
  priority,
  weight,
}: {
  action?: ReactNode;
  credentialId: string;
  disabled?: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onPriorityChange: (priority: string) => void;
  onWeightChange: (weight: string) => void;
  priority: string;
  weight: string;
}) {
  return (
    <FieldGroup>
      <Field orientation="horizontal" data-disabled={disabled || undefined}>
        <FieldContent>
          <FieldLabel htmlFor={`provider-enabled-${credentialId}`}>
            启用凭据
          </FieldLabel>
          <FieldDescription>关闭后不再参与路由和订阅分发。</FieldDescription>
        </FieldContent>
        <Switch
          id={`provider-enabled-${credentialId}`}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(value) => onEnabledChange(Boolean(value))}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={`provider-priority-${credentialId}`}>
            优先级
          </FieldLabel>
          <Input id={`provider-priority-${credentialId}`} inputMode="numeric" disabled={disabled} value={priority} onChange={(event) => onPriorityChange(event.target.value)} />
        </Field>
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={`provider-weight-${credentialId}`}>
            权重
          </FieldLabel>
          <Input id={`provider-weight-${credentialId}`} inputMode="numeric" disabled={disabled} value={weight} onChange={(event) => onWeightChange(event.target.value)} />
        </Field>
        {action && <div className="flex items-end">{action}</div>}
      </div>
    </FieldGroup>
  );
}
