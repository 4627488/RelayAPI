# Agent Note: Slim the native-era frontend surface

Status: implemented

## Problem

The console still loaded like a CPA-era control plane: admin workspace blocked every page on overview + usage + users + invitations + logs; ten sidebar items repeated 用户/邀请 and 系统设置/代理; most pages restated the shell title; runtime settings advertised “Relay Native” and “透明重试”. After the runtime became the only mode, that chrome was leftover weight and made 模型管理 / 系统设置 wait on unrelated APIs.

## Decision

Each admin and user page fetches only what it shows. 用户 owns 账号 + 邀请 tabs; 系统设置 owns 运行策略 + 出站代理. `invitations` and `proxies` remain internal page ids so overview shortcuts still work; the sidebar highlights 用户 / 系统设置. Duplicate page titles and the header theme picker are gone (theme stays in the account menu). Runtime settings is a form: 轮询 vs 固定优先级, 凭据隔离, 系统代理, deploy bounds — no Native badge, no “透明重试”, sticky save when dirty. Overview still shows eight recent logs and links to 请求日志.

## Alternatives considered

**Rewrite providers / subscriptions / logs workbench.** Those are the product, not CPA leftovers.

**Delete outbound proxies.** Account traffic still binds proxies on 模型管理; only the standalone 代理 nav item was redundant with 系统设置.

**URL routes for tabs.** Page state is in-memory; tabs plus reserved page ids are enough without adding a router.

## Consequences

Opening 模型管理, 模型设置, or 系统设置 no longer waits on usage or log queries. Operators add users from the 用户 page. System proxy picker and proxy CRUD share one settings page.
