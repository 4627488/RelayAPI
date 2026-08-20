# Agent Note: Hot-configure process bounds and drop the global circuit

Status: implemented

## Problem

管理端把响应头超时、请求体上限、在途内存、回收阈值、未定价模型和上游 WebSocket 画成只读「部署边界」，并写着必须改环境变量再重启。生产因此卡在 600s / 32 MiB / 拒绝 / WebSocket 关闭。同一张卡片上的全局熔断（连续 3 次传输失败停 15 秒）会把整站拦掉，和已经热更新的凭据隔离重复。

## Decision

These bounds live in the stored `native-runtime` settings document and apply on save: request body and admission budget swap the in-process gateway client, response-header timeout rebuilds provider transports (`ResponseHeaderTimeout`, not `Client.Timeout`), WebSocket policy reloads credentials and the Codex catalog flag. Missing stored fields take large defaults (24h / 1 GiB / 8 GiB / allow) except WebSocket and unpriced policy, which seed from env so a production host that already closed them does not flip on upgrade. The process-wide circuit defaults to off (`threshold=0`) and is no longer shown.

## Alternatives considered

**Keep env-only limits and tell operators to restart.** That is the current pain.

**Also hot-edit max-in-flight / queue.** Those still resize process channels and were not on the 部署边界 list.

**Delete the circuit implementation.** Disabling it is enough; the admission tests still cover the optional path.

## Consequences

Operators change the former deploy bounds from 运行策略 without restart. New installs and missing stored fields start wide open. A host that set `RELAY_UPSTREAM_WEBSOCKETS=false` or `UNPRICED_MODEL_POLICY=deny` keeps that until someone saves a new value.
