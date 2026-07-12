import { isWebRequestAuthenticated } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CLIProxyAPI-style flow: the OAuth redirect URI is fixed to localhost:1455.
// If the browser lands here, ask the user to paste the full callback URL back
// instead of relying on this app to own that callback port.
export async function GET(request: Request) {
  if (!isWebRequestAuthenticated(request)) {
    return Response.redirect(new URL("/", request.url), 303);
  }

  return new Response(renderCallbackPastePage(request.url), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderCallbackPastePage(callbackUrl: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>粘贴 Codex OAuth Callback</title>
  <style>
    :root { color-scheme: light dark; --background: #ffffff; --foreground: #18181b; --card: #ffffff; --border: #e4e4e7; --muted: #52525b; --input: #fafafa; }
    @media (prefers-color-scheme: dark) { :root { --background: #09090b; --foreground: #f4f4f5; --card: #18181b; --border: #3f3f46; --muted: #d4d4d8; --input: #09090b; } }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--background); color: var(--foreground); }
    main { max-width: 760px; margin: 0 auto; padding: 48px 20px; }
    section { border: 1px solid var(--border); background: var(--card); border-radius: 24px; padding: 28px; }
    textarea { box-sizing: border-box; width: 100%; min-height: 112px; margin-top: 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--input); color: var(--foreground); padding: 12px; }
    button { margin-top: 12px; padding: 10px 14px; border-radius: 999px; border: 0; background: #3b82f6; color: white; font-weight: 700; }
    p { line-height: 1.7; color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>粘贴 Codex OAuth callback URL</h1>
      <p>请确认下面是浏览器最终跳转到的完整 callback URL，然后提交给 RelayAPI 完成 token exchange。</p>
      <form method="post" action="/auth/callback-input">
        <textarea name="callback_url">${escapeHtml(callbackUrl)}</textarea>
        <button type="submit">提交 callback URL</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
