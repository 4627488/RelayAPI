export function githubResultMessage(result: string | null) {
  const messages: Record<string, string> = {
    bound: "GitHub 账户已绑定，下次可以直接使用 GitHub 登录。",
    unbound:
      "该 GitHub 账户尚未绑定，或对应账户已停用或过期。请先用邮箱和密码登录，在账户设置中绑定。",
    invalid_state: "授权已过期或登录状态发生变化，请重新发起。",
    denied: "已取消 GitHub 授权。",
    disabled: "GitHub 登录尚未配置。",
    conflict: "绑定未完成：该 GitHub 或当前账户可能已绑定，请刷新检查。",
    failed: "GitHub 授权失败，请重试。",
  }
  return result ? (messages[result] ?? "") : ""
}
