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
import {
  createProject,
  listArtifacts,
  listBible,
  listProjectSessions,
  listProjects,
  listSkills,
  readArtifact,
  readSessionMessages,
} from "./workspace.ts";
import { renderArtifact } from "./preview.ts";
import { lanHost } from "./lan.ts";
import { checkWorkbench } from "./diagnostics.ts";

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: SessionStore,
): Promise<void> {
  try {
    const p = url.pathname;

    if (p === "/api/health" && req.method === "GET") {
      const health = await checkWorkbench({ skipPort: true });
      return json(res, health.ok ? 200 : 503, {
        ...health,
        activeSessions: store.list().map((s) => ({
          id: s.id,
          project: s.project,
          mode: s.mode,
          paused: s.paused,
        })),
      });
    }

    if (p === "/api/projects" && req.method === "GET") {
      return json(res, 200, await listProjects());
    }

    if (p === "/api/projects" && req.method === "POST") {
      const body = await readJson(req);
      const entry = await createProject(String(body?.name ?? ""), String(body?.type ?? "create"));
      return json(res, 201, entry);
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

    // GET /api/projects/:name/sessions|bible|skills
    const projectRouteMatch = p.match(/^\/api\/projects\/([^/]+)\/(sessions|bible|skills)$/);
    if (projectRouteMatch) {
      const name = decodeURIComponent(projectRouteMatch[1]);
      const sub = projectRouteMatch[2];
      if (sub === "sessions") return json(res, 200, await listProjectSessions(name));
      if (sub === "bible") return json(res, 200, await listBible(name));
      if (sub === "skills") return json(res, 200, await listSkills(name));
    }

    // GET /api/sessions/:id/messages
    const sessMatch = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (sessMatch) {
      return json(res, 200, await readSessionMessages(decodeURIComponent(sessMatch[1])));
    }

    json(res, 404, { error: "unknown api route" });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
}
