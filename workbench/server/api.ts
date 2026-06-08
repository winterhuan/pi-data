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
import { basename } from "node:path";
import QRCode from "qrcode";
import type { SessionStore } from "./session.ts";
import {
  createProject,
  createArtifact,
  buildProjectHandoff,
  createProjectHandoff,
  createDeliveryPackage,
  exportProject,
  importProjectZip,
  listArtifactDetails,
  listTrashedArtifacts,
  listArtifacts,
  listBible,
  getWorkspaceOverview,
  getProjectBrief,
  getProjectDeliverables,
  getProjectReadiness,
  getDeliveryCheck,
  listProjectSessions,
  listProjects,
  listSkills,
  listWorkspaceActivity,
  listWorkspaceActions,
  listArtifactVersions,
  readArtifact,
  readArtifactVersion,
  readSessionMessages,
  renameProject,
  restoreArtifactVersion,
  restoreTrashedArtifact,
  searchWorkspace,
  setProjectPinned,
  setProjectBrief,
  setProjectTags,
  setProjectType,
  trashArtifact,
  updateArtifact,
} from "./workspace.ts";
import { renderArtifact } from "./preview.ts";
import { analyzeArtifactQuality } from "./quality.ts";
import { lanHost } from "./lan.ts";
import { checkWorkbench } from "./diagnostics.ts";
import { findStarterTemplate, listStarterTemplates } from "./starters.ts";

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function attachmentName(file: string): string {
  return encodeURIComponent(basename(file)).replace(/['()]/g, escape).replace(/\*/g, "%2A");
}

function artifactContentType(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lower.endsWith(".fountain")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function zipAttachmentName(file: string): string {
  return encodeURIComponent(file).replace(/['()]/g, escape).replace(/\*/g, "%2A");
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

    if (p === "/api/dashboard" && req.method === "GET") {
      const [health, workspace] = await Promise.all([
        checkWorkbench({ skipPort: true }),
        getWorkspaceOverview(),
      ]);
      const activeSessions = store.list().map((s) => ({
        id: s.id,
        project: s.project,
        mode: s.mode,
        paused: s.paused,
      }));
      const checks = {
        ok: health.checks.filter((c) => c.status === "ok").length,
        warning: health.checks.filter((c) => c.status === "warning").length,
        error: health.checks.filter((c) => c.status === "error").length,
      };
      const mobilePath = "/mobile";
      const mobileUrl = `http://${lanHost(req.headers.host ?? "localhost:7777")}${mobilePath}`;
      return json(res, 200, {
        health: {
          ok: health.ok,
          lanIp: health.lanIp,
          piSdkVersion: health.piSdkVersion,
          piCliVersion: health.piCliVersion,
          checks,
        },
        runtime: {
          activeSessions,
          mobilePath,
          mobileUrl,
        },
        workspace,
      });
    }

    if (p === "/api/projects" && req.method === "GET") {
      return json(res, 200, await listProjects());
    }

    if (p === "/api/actions" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 12);
      return json(res, 200, await listWorkspaceActions(Number.isFinite(limit) ? limit : 12));
    }

    if (p === "/api/activity" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 16);
      return json(res, 200, await listWorkspaceActivity(Number.isFinite(limit) ? limit : 16));
    }

    if (p === "/api/search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 30);
      return json(res, 200, await searchWorkspace(q, Number.isFinite(limit) ? limit : 30));
    }

    if (p === "/api/starters" && req.method === "GET") {
      return json(res, 200, listStarterTemplates());
    }

    const starterMatch = p.match(/^\/api\/starters\/([^/]+)$/);
    if (starterMatch && req.method === "GET") {
      const starter = findStarterTemplate(decodeURIComponent(starterMatch[1]));
      return starter ? json(res, 200, starter) : json(res, 404, { error: "starter not found" });
    }

    if (p === "/api/projects" && req.method === "POST") {
      const body = await readJson(req);
      const entry = await createProject(String(body?.name ?? ""), String(body?.type ?? "create"));
      return json(res, 201, entry);
    }

    if (p === "/api/projects/import" && req.method === "POST") {
      const body = await readJson(req);
      const base64 = String(body?.zipBase64 ?? "");
      if (!base64) return json(res, 400, { error: "zipBase64 is required" });
      try {
        const result = await importProjectZip(Buffer.from(base64, "base64"), body?.name ? String(body.name) : undefined);
        return json(res, 201, result);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message || "import failed" });
      }
    }

    const exportMatch = p.match(/^\/api\/project\/([^/]+)\/export$/);
    if (exportMatch && req.method === "GET") {
      try {
        const bundle = await exportProject(decodeURIComponent(exportMatch[1]));
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename*=UTF-8''${zipAttachmentName(bundle.filename)}`,
        });
        return res.end(bundle.zip);
      } catch {
        return json(res, 404, { error: "project not found" });
      }
    }

    const deliveryMatch = p.match(/^\/api\/project\/([^/]+)\/delivery$/);
    if (deliveryMatch && req.method === "GET") {
      try {
        const bundle = await createDeliveryPackage(decodeURIComponent(deliveryMatch[1]));
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename*=UTF-8''${zipAttachmentName(bundle.filename)}`,
        });
        return res.end(bundle.zip);
      } catch {
        return json(res, 404, { error: "project not found" });
      }
    }

    const projectDetailsMatch = p.match(/^\/api\/project\/([^/]+)\/details$/);
    if (projectDetailsMatch && req.method === "GET") {
      const name = decodeURIComponent(projectDetailsMatch[1]);
      return json(res, 200, await listArtifactDetails(name));
    }

    const projectDeliverablesMatch = p.match(/^\/api\/project\/([^/]+)\/deliverables$/);
    if (projectDeliverablesMatch && req.method === "GET") {
      const name = decodeURIComponent(projectDeliverablesMatch[1]);
      return json(res, 200, await getProjectDeliverables(name));
    }

    const projectReadinessMatch = p.match(/^\/api\/project\/([^/]+)\/readiness$/);
    if (projectReadinessMatch && req.method === "GET") {
      const name = decodeURIComponent(projectReadinessMatch[1]);
      return json(res, 200, await getProjectReadiness(name));
    }

    const projectDeliveryCheckMatch = p.match(/^\/api\/project\/([^/]+)\/delivery-check$/);
    if (projectDeliveryCheckMatch && req.method === "GET") {
      try {
        const name = decodeURIComponent(projectDeliveryCheckMatch[1]);
        return json(res, 200, await getDeliveryCheck(name));
      } catch {
        return json(res, 404, { error: "project not found" });
      }
    }

    const projectBriefMatch = p.match(/^\/api\/project\/([^/]+)\/brief$/);
    if (projectBriefMatch && req.method === "GET") {
      try {
        const name = decodeURIComponent(projectBriefMatch[1]);
        return json(res, 200, await getProjectBrief(name));
      } catch {
        return json(res, 404, { error: "project not found" });
      }
    }

    if (projectBriefMatch && req.method === "PUT") {
      const body = await readJson(req);
      try {
        const name = decodeURIComponent(projectBriefMatch[1]);
        return json(res, 200, await setProjectBrief({
          project: name,
          brief: body ?? {},
          timestamp: new Date().toISOString(),
        }));
      } catch (err) {
        const message = (err as Error).message || "project brief update failed";
        const code = message.includes("not found") ? 404 : 400;
        return json(res, code, { error: message });
      }
    }

    const projectTrashMatch = p.match(/^\/api\/project\/([^/]+)\/trash$/);
    if (projectTrashMatch && req.method === "GET") {
      const name = decodeURIComponent(projectTrashMatch[1]);
      return json(res, 200, await listTrashedArtifacts(name));
    }

    const projectTrashRestoreMatch = p.match(/^\/api\/project\/([^/]+)\/trash\/restore$/);
    if (projectTrashRestoreMatch && req.method === "POST") {
      const body = await readJson(req);
      try {
        const name = decodeURIComponent(projectTrashRestoreMatch[1]);
        const artifact = await restoreTrashedArtifact({
          project: name,
          trashedFile: String(body?.trashedFile ?? ""),
          timestamp: new Date().toISOString(),
        });
        return json(res, 200, { project: name, artifact });
      } catch (err) {
        const message = (err as Error).message || "restore failed";
        const code = message.includes("already exists") ? 409 : 404;
        return json(res, code, { error: message });
      }
    }

    const projectRenameMatch = p.match(/^\/api\/project\/([^/]+)$/);
    if (projectRenameMatch && req.method === "PUT") {
      const body = await readJson(req);
      try {
        const from = decodeURIComponent(projectRenameMatch[1]);
        const entry = await renameProject({
          from,
          to: String(body?.name ?? ""),
          timestamp: new Date().toISOString(),
        });
        return json(res, 200, entry);
      } catch (err) {
        const message = (err as Error).message || "project rename failed";
        const code = message.includes("already exists") ? 409 : message.includes("not found") ? 404 : 400;
        return json(res, code, { error: message });
      }
    }

    const projectPinMatch = p.match(/^\/api\/project\/([^/]+)\/pin$/);
    if (projectPinMatch && req.method === "PATCH") {
      const body = await readJson(req);
      try {
        const project = decodeURIComponent(projectPinMatch[1]);
        const entry = await setProjectPinned({
          project,
          pinned: Boolean(body?.pinned),
          timestamp: new Date().toISOString(),
        });
        return json(res, 200, entry);
      } catch {
        return json(res, 404, { error: "project not found" });
      }
    }

    const projectTypeMatch = p.match(/^\/api\/project\/([^/]+)\/type$/);
    if (projectTypeMatch && req.method === "PATCH") {
      const body = await readJson(req);
      try {
        const project = decodeURIComponent(projectTypeMatch[1]);
        const entry = await setProjectType({
          project,
          type: String(body?.type ?? ""),
          timestamp: new Date().toISOString(),
        });
        return json(res, 200, entry);
      } catch (err) {
        const message = (err as Error).message || "project type update failed";
        const code = message.includes("not found") ? 404 : 400;
        return json(res, code, { error: message });
      }
    }

    const projectTagsMatch = p.match(/^\/api\/project\/([^/]+)\/tags$/);
    if (projectTagsMatch && req.method === "PATCH") {
      const body = await readJson(req);
      try {
        const entry = await setProjectTags({
          project: decodeURIComponent(projectTagsMatch[1]),
          tags: body?.tags ?? "",
          timestamp: new Date().toISOString(),
        });
        return json(res, 200, entry);
      } catch (err) {
        const message = (err as Error).message || "tag update failed";
        const code = message.includes("not found") ? 404 : 400;
        return json(res, code, { error: message });
      }
    }

    const projectHandoffMatch = p.match(/^\/api\/project\/([^/]+)\/handoff$/);
    if (projectHandoffMatch && req.method === "GET") {
      try {
        const name = decodeURIComponent(projectHandoffMatch[1]);
        return json(res, 200, await buildProjectHandoff(name));
      } catch {
        return json(res, 404, { error: "project not found" });
      }
    }

    if (projectHandoffMatch && req.method === "POST") {
      try {
        const name = decodeURIComponent(projectHandoffMatch[1]);
        return json(res, 201, await createProjectHandoff(name));
      } catch {
        return json(res, 404, { error: "project not found" });
      }
    }

    const projectArtifactsMatch = p.match(/^\/api\/project\/([^/]+)$/);
    if (projectArtifactsMatch && req.method === "GET") {
      const name = decodeURIComponent(projectArtifactsMatch[1]);
      return json(res, 200, await listArtifacts(name));
    }

    if (p === "/api/artifact" && req.method === "GET") {
      const project = url.searchParams.get("project") ?? "";
      const file = url.searchParams.get("file") ?? "";
      try {
        const content = await readArtifact(project, file);
        return json(res, 200, { project, file, content });
      } catch {
        return json(res, 404, { error: "artifact not found" });
      }
    }

    if (p === "/api/artifact" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const project = String(body?.project ?? "");
        const file = String(body?.file ?? "");
        const content = String(body?.content ?? "");
        const artifact = await createArtifact({
          project,
          filename: file,
          content,
          type: body?.type ? String(body.type) : undefined,
          timestamp: new Date().toISOString(),
        });
        return json(res, 201, { project, file, artifact });
      } catch (err) {
        const message = (err as Error).message || "artifact create failed";
        const code = message.includes("already exists") ? 409 : 400;
        return json(res, code, { error: message });
      }
    }

    if (p === "/api/artifact" && req.method === "PUT") {
      const body = await readJson(req);
      try {
        const project = String(body?.project ?? "");
        const file = String(body?.file ?? "");
        const content = String(body?.content ?? "");
        const artifact = await updateArtifact({
          project,
          filename: file,
          content,
          timestamp: new Date().toISOString(),
        });
        return json(res, 200, { project, file, artifact });
      } catch {
        return json(res, 404, { error: "artifact not found" });
      }
    }

    if (p === "/api/artifact" && req.method === "DELETE") {
      const body = await readJson(req);
      try {
        const project = String(body?.project ?? "");
        const file = String(body?.file ?? "");
        const trashed = await trashArtifact({
          project,
          filename: file,
          timestamp: new Date().toISOString(),
        });
        return json(res, 200, { project, file, trashed });
      } catch {
        return json(res, 404, { error: "artifact not found" });
      }
    }

    if (p === "/api/artifact/quality" && req.method === "GET") {
      const project = url.searchParams.get("project") ?? "";
      const file = url.searchParams.get("file") ?? "";
      try {
        const content = await readArtifact(project, file);
        return json(res, 200, { project, file, quality: analyzeArtifactQuality(file, content) });
      } catch {
        return json(res, 404, { error: "artifact not found" });
      }
    }

    if (p === "/api/artifact/history" && req.method === "GET") {
      const project = url.searchParams.get("project") ?? "";
      const file = url.searchParams.get("file") ?? "";
      try {
        return json(res, 200, await listArtifactVersions(project, file));
      } catch {
        return json(res, 404, { error: "artifact history not found" });
      }
    }

    if (p === "/api/artifact/history/content" && req.method === "GET") {
      const project = url.searchParams.get("project") ?? "";
      const file = url.searchParams.get("file") ?? "";
      const version = url.searchParams.get("version") ?? "";
      try {
        const content = await readArtifactVersion(project, file, version);
        return json(res, 200, { project, file, version, content });
      } catch {
        return json(res, 404, { error: "artifact version not found" });
      }
    }

    if (p === "/api/artifact/history/restore" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const project = String(body?.project ?? "");
        const file = String(body?.file ?? "");
        const version = String(body?.version ?? "");
        const artifact = await restoreArtifactVersion({
          project,
          filename: file,
          versionId: version,
          timestamp: new Date().toISOString(),
        });
        return json(res, 200, { project, file, version, artifact });
      } catch {
        return json(res, 404, { error: "artifact version not found" });
      }
    }

    if (p === "/api/download") {
      const project = url.searchParams.get("project") ?? "";
      const file = url.searchParams.get("file") ?? "";
      try {
        const content = await readArtifact(project, file);
        res.writeHead(200, {
          "content-type": artifactContentType(file),
          "content-disposition": `attachment; filename*=UTF-8''${attachmentName(file)}`,
        });
        return res.end(content);
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
