/**
 * api.ts — HTTP API 路由
 *
 * 问题: 前端档案室需要列项目/产物,预览页需要渲染产物为 HTML,手机需要二维码。
 *
 * 方案: 简单的 /api/* 路由分发。
 *   - GET  /api/projects            → 项目列表(读 workspace/index.json)
 *   - GET  /api/project/:name       → 单项目产物列表
 *   - GET  /api/artifact?project&file → 产物原始内容
 *   - GET  /api/preview?project&file → 产物渲染为 HTML 片段
 *   - GET  /api/qr?path             → 指定路径的二维码(PNG data URL)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import QRCode from "qrcode";
import type { SessionStore } from "./session.ts";
import { listProjects, listArtifacts, readArtifact } from "./workspace.ts";
import { renderArtifact } from "./preview.ts";
import { lanHost } from "./lan.ts";

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _store: SessionStore,
): Promise<void> {
  try {
    const p = url.pathname;

    if (p === "/api/projects") {
      return json(res, 200, await listProjects());
    }

    if (p.startsWith("/api/project/")) {
      const name = decodeURIComponent(p.slice("/api/project/".length));
      return json(res, 200, await listArtifacts(name));
    }

    if (p === "/api/artifact") {
      const project = url.searchParams.get("project") ?? "";
      const file = url.searchParams.get("file") ?? "";
      try {
        const content = await readArtifact(project, file);
        return json(res, 200, { project, file, content });
      } catch {
        return json(res, 404, { error: "artifact not found" });
      }
    }

    if (p === "/api/preview") {
      const project = url.searchParams.get("project") ?? "";
      const file = url.searchParams.get("file") ?? "";
      try {
        const content = await readArtifact(project, file);
        return json(res, 200, { html: renderArtifact(file, content) });
      } catch {
        return json(res, 404, { error: "artifact not found" });
      }
    }

    if (p === "/api/qr") {
      const path = url.searchParams.get("path") ?? "/";
      // 用局域网 IP 而非 localhost,手机扫码才能打开
      const host = lanHost(req.headers.host ?? "localhost:7777");
      const target = `http://${host}${path}`;
      const dataUrl = await QRCode.toDataURL(target, { margin: 1, width: 240 });
      return json(res, 200, { target, dataUrl });
    }

    json(res, 404, { error: "unknown api route" });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
}
