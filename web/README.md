# RelayAPI Web

RelayAPI 的管理控制台，基于 React、TypeScript、Vite、Tailwind CSS v4 与 shadcn/ui（Base UI）构建。

## 本地开发

推荐使用 Node.js 24（与 CI、Docker 一致），最低要求为 22.18。开发、测试和构建使用 `--configLoader native`，直接加载 ESM TypeScript 配置；配置文件的相对导入需带 `.ts` 扩展名。

```bash
pnpm install
pnpm dev
```

如需让本地前端读取远端环境的 API，可在启动前设置
`RELAY_DEMO_API_TARGET=https://example.com`。默认仍代理到本机 3000 端口。

提交前运行完整前端门禁：

```bash
pnpm check
```

它会依次检查格式、类型、代码规范、真实 Chromium 中的组件与无障碍测试，以及生产构建。

Vite 8 已默认使用 Rolldown / Oxc。`resolve.tsconfigPaths` 直接读取 `tsconfig.app.json` 的 `@/*` 路径映射，无需在 Vite 中重复配置别名。

如需评估 Vite 8.1 的实验性打包开发模式，可运行 `pnpm dev --experimental-bundle`；目前不作为默认模式。实验性 chunk import map、Devtools 和 React Compiler 也未启用，应按实际需求单独验证。

## 界面规范

采用 shadcn `base-nova` 和 Base UI，统一使用 Neutral 明暗主题、系统字体及组件内置变体。颜色用于表达交互和数据状态，不额外添加品牌色或装饰性背景。

主题集中定义在 `src/index.css`，组件外观集中维护在 `src/components/ui`；不要重新应用默认预设覆盖项目主题。

- 组件优先使用 `src/components/ui` 中的 shadcn 原语，业务页面不要手写按钮、选择器、对话框、提示框、空状态、进度条或开关。
- 页面通过 `PageHeader` 提供唯一的一级标题；说明只保留当前范围、限制或会影响操作的信息；区块标题从二级开始，不用大小相同的文字模拟层级。
- 业务页面使用 `background`、`card`、`foreground`、`muted`、`primary`、`destructive` 等语义令牌，不单独硬编码主题色。图表使用 `chart-*` 令牌；状态优先使用 Badge 变体和文字。
- 字体、圆角、阴影和控件尺寸在公共组件统一维护。业务 `className` 用于布局、响应式尺寸和数据可读性，不重复覆盖组件外观；不添加全局字体渲染、滚动条或表单样式。
- 筛选选项使用 `ToggleGroup` 的内置变体，页面分区使用 `Tabs`，工作区切换统一放在账户菜单；系统设置按说明与控件分栏，手机端纵向排列。
- 总览保留核心指标与常用入口，详细性能、错误归因和计费分析集中在用量页。统计定义通过可点击的说明浮层按需展示。
- 保存期间禁用对应表单；失败保留草稿。破坏性操作使用 `AlertDialog`，Esc 和关闭后焦点恢复由 Base UI 管理。
- 表格使用公共横向滚动容器，不在基础 Table 中添加固定列接口。提示消息使用 Base UI 的 `toast.add`，复用 `components/ui/toast`。
- 状态不能只靠颜色表达；错误、成功、加载和空状态同时提供文字或图标。所有仅图标按钮必须有可读名称。
- 页面导航使用 `src/lib/routes.ts` 的地址生成与解析函数，不在组件里维护另一套页面状态，也不新增自定义 hash 路由。
- 数据页面必须覆盖首次加载、保留旧数据的刷新、可重试错误和空结果；共用 `LoadingView`、`LoadErrorView`、`Empty` 与 `InfoBar`。
- 大型页面功能通过 `React.lazy` 按路由加载。不要把图表、日志详情或管理弹窗重新打进首屏共享包。

## 路由约定

### 页面组织

- `components/app-shell.tsx` 负责工作区外壳，`lib/navigation.ts` 集中维护导航分组和显示名称。
- `components/user-workspace.tsx` 与 `components/admin-workspace.tsx` 只负责路由分发；具体页面放在 `components/user/`、`components/admin/`，按需加载。
- 模型账户的连接、管理、测试弹窗放在 `components/providers/`；共用类型和纯函数放在同目录的 `provider-helpers.ts`，弹窗不要反向引用列表页面。
- `workspace-ui.tsx` 维护页面标题、分组统计区和搜索框；页面说明使用 `PageHeader.description`，优先在这里调整共用布局。
- 列表筛选要区分“尚无数据”和“筛选无结果”，后者提供清除筛选入口。手机端隐藏列时，仍需保留名称、状态和主要操作。

### 上游配置交互

- 模型账户是上游管理与用户授权的唯一入口。列表展示身份、调度状态、模型、上游额度及用户授权摘要；端点、代理和请求累计放在详情。“可调度”不代表已通过连通性测试。
- 详情使用 Sheet，按用户授权、运行状态、模型发布、连接设置和凭据分区。授权按上游凭据 ID 关联，禁止匹配失败时回退到其他账户。保存只提交当前分区；其他分区草稿保留，关闭前确认放弃，有草稿时须先保存再进入授权。
- 用户授权保留余额结算与共享额度两种规则；不再为同一账户编辑第二个显示名称。历史授权在模型账户页单独查看，允许迁移到现存账户。旧 `/admin/subscriptions` 地址归一到 `/admin/providers`，个人订阅入口保持独立。
- 「我的订阅」只展示共享额度，以分隔线列表组织名称、有效期和额度；不展示上游身份。12px 额度条使用局部绿、橙、红语义色及深色对应色，表示充足、偏低、紧张，不修改全局主题。订阅到期与额度重置分别展示，临近到期、已到期、待生效、额度用尽和等待重置不得混为一个状态。
- `/app/models` 按模型 ID 合并用户的模型权限，余额授权不按账户展示，订阅结算链接到 `/app/subscriptions#subscription-<id>` 对应段落。目录使用租户会话的 `/api/models`，按当前原生模型、授权生命周期与实际结算规则生成；不能把被订阅承接的模型标成可自动改用余额。
- 模型目录刷新只更新候选项，不能自动改变已发布模型；刷新失败也必须保留选择。连接设置保存不能附带模型，以免触发后端模型发现。
- 创建 API Key 默认选择“全部可用模型”，以空模型列表持续继承用户的余额和订阅权限，包括以后新增的模型。候选模型来自 `/api/models`，不拼接租户白名单和订阅快照；候选目录异步加载、添加别名预设不能把继承模式改为固定白名单。编辑保留原限制，不能因取消最后一项而静默扩大权限。
- 请求头明确区分保持、整体替换和清空；服务端只返回头名称，界面不应伪造原值。OAuth 和账户测试关闭后必须忽略迟到结果，并尽可能取消请求。

### 地址

- 用户工作台：`/app`、`/app/usage`、`/app/keys`、`/app/logs/:id`
- 管理工作台：`/admin`、`/admin/users/invitations`、`/admin/settings/proxies`、`/admin/logs/:id`
- 日志 ID 必须通过 `routeHref` 编码；旧的 `#log=` 地址只用于兼容迁移。

## 测试约定

- 浏览器测试文件命名为 `*.browser.test.tsx`。
- 共享组件至少验证可访问名称、键盘操作和 axe WCAG 规则。
- 路由变更至少验证可刷新恢复、包含特殊字符的日志 ID，以及未知地址的安全回退。
- 测试失败产生的截图和 trace 位于忽略目录中，不提交到仓库。

## 添加组件

先确认项目中没有等价原语，再通过 shadcn CLI 添加：

```bash
pnpm dlx shadcn@latest add <component>
```

保持 `components.json` 中的 `base-nova`、Base UI 和 Lucide 配置。官方组件更新通过 CLI 比较后应用，功能组合放在业务模块，避免修改基础组件。
