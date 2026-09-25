# GitHub 登录与主动绑定

在 GitHub 注册 OAuth App，主页为站点地址，回调为 `<RELAY_PUBLIC_URL>/api/auth/github/callback`，不要启用回调通配符。服务端配置 `RELAY_GITHUB_CLIENT_ID` 和 `RELAY_GITHUB_CLIENT_SECRET`，两者必须同时设置。线上使用 HTTPS，配置 `RELAY_SECURE_COOKIES=true`，并确保 `RELAY_PUBLIC_URL` 与浏览器访问的 origin 一致。容器部署由现有 `.env` 注入变量；不要把 Client Secret 提交到 Git。

1. 用户先使用已有邮箱和密码登录；新用户仍需按现有规则注册。
2. 在个人工作台的「账户设置」输入当前密码，点击「绑定 GitHub」。
3. 在 GitHub 选择账户并授权，返回后显示已绑定的用户名。
4. 下次在登录页选择「使用 GitHub 登录」。未绑定、停用或过期账户不能通过 GitHub 获得访问权限。

服务器无法直连 GitHub 时，在「系统设置 → 运行策略 → GitHub 登录代理」选择直连、跟随系统代理或一个已有出站代理。保存后新授权流程即时使用设置，授权码交换（github.com）与身份查询（api.github.com）走同一代理；回调 URL 不变。HTTP、HTTPS、SOCKS5、SOCKS5H 由现有出站代理组件处理。所选代理不可用时明确失败，不静默切回直连；被 GitHub 登录引用的代理不能直接删除。授权码过期或已使用后必须重新发起授权。

解绑同样需要当前密码。解绑后保留邮箱密码登录方式，并使其他浏览器会话失效。需要更换 GitHub 账户时先解绑再绑定；一个 GitHub 用户 ID 只能绑定一个本站账户。不会按邮箱或同名用户名自动合并，不改变管理员身份与订阅权限。

只获取 GitHub 公共身份，不申请仓库或邮箱权限，不持久化 GitHub access token 或 refresh token。授权使用随机 state、PKCE S256、十分钟加密 cookie；绑定回调要求原来的本站会话保持有效。授权过期、取消或账户冲突会显示相应提示。

协议依据：[GitHub OAuth Web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow)。
