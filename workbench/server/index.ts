/**
 * index.ts — workbench-server 入口
 *
 * 问题: 浏览器/手机需要一个本地 server 把 Pi SDK 的流式输出桥接到 WebSocket,
 * 并提供静态页、产物预览、二维码。启动时若 Pi auth 失败,必须显式报错(不静默)。
 *
 * 方案: Node http + ws。启动先做 auth 预检 → 失败则所有页面显示错误页+指引。
 *   WebSocket 按 {sessionId, type, payload} 路由到对应 AgentSession。
 *
 *   架构:
 *     浏览器/手机 ⇄ WebSocket ⇄ SessionStore ⇄ Pi SDK (createAgentSession)
 *                 ⇄ HTTP(静态 / /preview/:id / /mobile / /api/*)
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { SessionStore } from "./session.ts";
import { attachWebSocket } from "./ws.ts";
import { handleApi } from "./api.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const PORT = Number(process.env.PORT ?? 7777);

/** 启动 auth 预检:有没有可用模型?返回 null 表示就绪,否则返回错误信息。 */
async function checkAuth(): Promise<string | null> {
  try {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const available = await modelRegistry.getAvailable();
    if (!available || available.length === 0) {
      return "没有可用模型。请检查 ~/.pi/agent/auth.json 或设置 API key 环境变量。";
    }
    return null;
  } catch (err) {
    return `Pi auth 初始化失败: ${(err as Error).message}。请检查 ~/.pi/agent/auth.json。`;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function errorPage(reason: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>工作台未就绪</title>
<style>body{font-family:system-ui;background:#1a1a1a;color:#e0e0e0;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{max-width:560px;padding:2rem}h1{color:#ff6b6b;font-size:1.3rem}
code{background:#2a2a2a;padding:.2em .4em;border-radius:4px;font-size:.9em}
pre{background:#2a2a2a;padding:1rem;border-radius:8px;overflow:auto}</style></head>
<body><div class="box"><h1>⚠ 工作台未就绪</h1><p>${reason}</p>
<p>修复后刷新本页。配置 API key:</p>
<pre>pi auth  # 或编辑 ~/.pi/agent/auth.json</pre></div></body></html>`;
}

async function main() {
  const authError = await checkAuth();
  if (authError) {
    console.error(`[startup] auth 检测失败: ${authError}`);
  } else {
    console.log("[startup] Pi auth 就绪");
  }

  const store = new SessionStore();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // auth 失败:所有页面显示错误页
    if (authError && !url.pathname.startsWith("/api/")) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
      res.end(errorPage(authError));
      return;
    }

    // API 路由
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url, store);
      return;
    }

    // 静态文件:/ → index.html,/mobile → mobile.html,其余按文件名
    let file = url.pathname === "/" ? "index.html"
      : url.pathname === "/mobile" ? "mobile.html"
      : url.pathname.slice(1);
    if (url.pathname.startsWith("/preview/")) file = "preview.html";

    try {
      const body = await readFile(join(WEB_DIR, file));
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });

  attachWebSocket(server, store);

  server.listen(PORT, () => {
    console.log(`[workbench] http://localhost:${PORT}  (手机同局域网访问本机 IP:${PORT})`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
