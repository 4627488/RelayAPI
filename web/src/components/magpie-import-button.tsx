import { useEffect, useRef, useState } from "react"
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  MinusIcon,
  XIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { api } from "@/lib/api"
import { copyText } from "@/lib/clipboard"

interface MagpieImport {
  href: string
  name: string
  base_url: string
  key: string
  protocol: "responses"
  balance_supported: boolean
  configure_command?: string
}

interface ConnectionCheck {
  name: "key" | "models" | "balance" | "generation"
  status: "ok" | "error" | "skipped"
  message: string
}

interface ConnectionReport {
  checks: ConnectionCheck[]
  models: string[]
  model?: string
  request_id?: string
}

const checkNames = {
  key: "密钥",
  models: "模型目录",
  balance: "余额与额度",
  generation: "生成测试",
}

export function MagpieImportButton({ keyID }: { keyID: string }) {
  const [open, setOpen] = useState(false)
  const [setup, setSetup] = useState<MagpieImport | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [checking, setChecking] = useState<"metadata" | "generation" | null>(
    null
  )
  const [checks, setChecks] = useState<ConnectionCheck[]>([])
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState("")
  const [requestID, setRequestID] = useState("")
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const endpoint = `/api/keys/${encodeURIComponent(keyID)}/magpie`

  async function loadSetup() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setOpen(true)
    setSetup(null)
    setError("")
    setChecks([])
    setModels([])
    setModel("")
    setRequestID("")
    setPending(true)
    try {
      const config = await api<MagpieImport>(endpoint, {
        signal: controller.signal,
      })
      if (!controller.signal.aborted) setSetup(config)
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "无法读取 Magpie 配置"
        )
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }

  async function checkConnection(generate: boolean) {
    const controller = new AbortController()
    request.current = controller
    setChecking(generate ? "generation" : "metadata")
    setError("")
    setRequestID("")
    try {
      const result = await api<ConnectionReport>(`${endpoint}/check`, {
        method: "POST",
        body: JSON.stringify({
          generate,
          ...(generate && model ? { model } : {}),
        }),
        signal: controller.signal,
      })
      if (!controller.signal.aborted) {
        setChecks(result.checks)
        setModels(result.models)
        setModel(
          result.models.includes(model) ? model : (result.models[0] ?? "")
        )
        setRequestID(result.request_id ?? "")
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "连接检查失败")
    } finally {
      if (!controller.signal.aborted) setChecking(null)
    }
  }

  function changeOpen(value: boolean) {
    setOpen(value)
    if (!value) {
      request.current?.abort()
      setPending(false)
      setChecking(null)
      setSetup(null)
      setChecks([])
      setError("")
    }
  }

  return (
    <>
      <Button
        variant="outline"
        aria-busy={pending}
        disabled={pending}
        onClick={() => void loadSetup()}
      >
        {pending ? (
          <Spinner aria-hidden="true" data-icon="inline-start" />
        ) : null}
        连接 Magpie
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>连接 Magpie</DialogTitle>
            <DialogDescription>
              导入此密钥，或复制配置到本机 Magpie。
            </DialogDescription>
          </DialogHeader>
          {pending ? (
            <p
              role="status"
              className="flex items-center gap-2 text-muted-foreground"
            >
              <Spinner /> 正在读取配置…
            </p>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>暂时无法完成</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {!pending && !setup ? (
            <Button variant="outline" onClick={() => void loadSetup()}>
              重试读取配置
            </Button>
          ) : null}
          {setup ? (
            <>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium wrap-anywhere">
                  {setup.name}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    render={
                      <a href={setup.href} target="_blank" rel="noreferrer" />
                    }
                  >
                    导入到 Magpie <ExternalLinkIcon data-icon="inline-end" />
                  </Button>
                  <Button
                    variant="outline"
                    render={
                      <a
                        href="https://usemagpie.ai"
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    安装 Magpie <ExternalLinkIcon data-icon="inline-end" />
                  </Button>
                </div>
                {!setup.balance_supported ? (
                  <p className="text-xs text-muted-foreground">
                    Magpie 的额度查询要求
                    HTTPS；当前地址可导入调用配置，余额和订阅额度请在本站查看。
                  </p>
                ) : null}
              </div>
              {setup.configure_command ? (
                <FieldGroup>
                  <CopyField
                    label="Magpie 配置命令"
                    value={setup.configure_command}
                  />
                  <p className="text-xs text-muted-foreground">
                    导入后在本机终端运行一次，启用 Codex
                    原生远程压缩，配置计费类型和
                    WebSocket。自动模式在连接失败时回退
                    HTTP。更新已有服务商时也请运行。
                  </p>
                </FieldGroup>
              ) : null}
              <Separator />
              <FieldGroup>
                <CopyField label="Responses Base URL" value={setup.base_url} />
                <CopyField label="API Key" value={setup.key} secret />
                <p className="text-xs text-muted-foreground">
                  无法自动导入时，在 Magpie 添加自定义服务商，选择 Responses
                  并填写以上配置。模型列表保持自动发现。
                </p>
              </FieldGroup>
              <Separator />
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">连接检查</h3>
                  <p className="text-xs text-muted-foreground">
                    检查配置不生成内容。生成测试会发送一次最小请求，并按实际用量计费。
                  </p>
                </div>
                {models.length ? (
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="magpie-check-model">
                        生成测试模型
                      </FieldLabel>
                      <Select
                        value={model}
                        onValueChange={(value) => setModel(value ?? "")}
                        disabled={checking !== null}
                      >
                        <SelectTrigger
                          id="magpie-check-model"
                          className="w-full"
                        >
                          <SelectValue className="min-w-0" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {models.map((id) => (
                              <SelectItem key={id} value={id}>
                                {id}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </FieldGroup>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={checking !== null}
                    onClick={() => void checkConnection(false)}
                  >
                    {checking === "metadata" ? (
                      <Spinner aria-hidden="true" data-icon="inline-start" />
                    ) : null}
                    检查配置
                  </Button>
                  <Button
                    variant="outline"
                    disabled={checking !== null || !model}
                    onClick={() => void checkConnection(true)}
                  >
                    {checking === "generation" ? (
                      <Spinner aria-hidden="true" data-icon="inline-start" />
                    ) : null}
                    运行生成测试（计费）
                  </Button>
                </div>
                {!models.length ? (
                  <p className="text-xs text-muted-foreground">
                    先检查配置，读取可用模型后再选择生成测试。
                  </p>
                ) : null}
                {requestID ? (
                  <p className="text-xs break-all text-muted-foreground">
                    测试请求：<code>{requestID}</code>。可在{" "}
                    <a
                      href="/app/logs"
                      className="underline underline-offset-4"
                    >
                      调用记录
                    </a>{" "}
                    核对结果与费用。
                  </p>
                ) : null}
                {checks.length ? (
                  <ul
                    aria-label="连接检查结果"
                    aria-live="polite"
                    className="flex flex-col gap-3"
                  >
                    {checks.map((check) => (
                      <li key={check.name} className="flex items-start gap-2">
                        {check.status === "ok" ? (
                          <CheckIcon
                            aria-label="通过"
                            className="mt-0.5 size-4 shrink-0"
                          />
                        ) : check.status === "skipped" ? (
                          <MinusIcon
                            aria-label="跳过"
                            className="mt-0.5 size-4 shrink-0"
                          />
                        ) : (
                          <XIcon
                            aria-label="失败"
                            className="mt-0.5 size-4 shrink-0"
                          />
                        )}
                        <div className="flex flex-col gap-1">
                          <p className="text-sm font-medium">
                            {checkNames[check.name]}
                          </p>
                          <p className="text-xs wrap-anywhere text-muted-foreground">
                            {check.message}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function CopyField({
  label,
  value,
  secret = false,
}: {
  label: string
  value: string
  secret?: boolean
}) {
  async function copy() {
    try {
      await copyText(value)
      toast.add({ title: `已复制 ${label}`, type: "success" })
    } catch {
      toast.add({ title: "复制失败，请手动选择内容", type: "error" })
    }
  }

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          aria-label={label}
          readOnly
          type={secret ? "password" : "text"}
          value={value}
          className="font-mono text-xs"
        />
        <InputGroupAddon align="inline-end">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`复制 ${label}`}
            onClick={() => void copy()}
          >
            <CopyIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  )
}
