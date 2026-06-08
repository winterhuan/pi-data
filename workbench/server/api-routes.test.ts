import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleApi } from "./api.ts";
import { recordProjectSession, saveArtifact } from "./workspace.ts";
import { readZip } from "./zip.ts";

vi.mock("./diagnostics.ts", () => ({
  checkWorkbench: vi.fn(async () => ({
    ok: true,
    nodeVersion: "22.0.0",
    piSdkVersion: "0.78.0",
    piCliVersion: "0.78.0",
    workspace: "/tmp/workbench",
    lanIp: "192.168.1.2",
    extensionPath: "/home/user/.pi/agent/extensions/workbench",
    expectedExtensionTarget: "/repo/pi-ext/workbench",
    checks: [],
  })),
}));

describe("api routes", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "api-routes-"));
    process.env.WORKBENCH_WORKSPACE = tmpDir;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleApi(req, res, url, { list: () => [] } as any);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad test server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.WORKBENCH_WORKSPACE;
  });

  it("POST /api/projects creates a project and returns the entry", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "route-proj", type: "work" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "route-proj", name: "route-proj", type: "work" });

    const list = await (await fetch(`${baseUrl}/api/projects`)).json();
    expect(list.some((p: any) => p.name === "route-proj")).toBe(true);
  });

  it("GET /api/health returns diagnostics and active sessions", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.activeSessions).toEqual([]);
  });

  it("GET /api/dashboard returns health, runtime, and workspace summaries", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dash-proj", type: "create" }),
    });

    const res = await fetch(`${baseUrl}/api/dashboard`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.health).toMatchObject({
      ok: true,
      lanIp: "192.168.1.2",
      piSdkVersion: "0.78.0",
      piCliVersion: "0.78.0",
    });
    expect(body.runtime.mobilePath).toBe("/mobile");
    expect(body.runtime.mobileUrl).toContain("/mobile");
    expect(body.workspace.totals.projects).toBe(1);
    expect(body.workspace.recentProjects[0]).toMatchObject({
      name: "dash-proj",
      artifactCount: 0,
      sessionCount: 0,
    });
    expect(body.workspace.recentProjects[0].deliverables).toMatchObject({
      done: 0,
      total: expect.any(Number),
      percent: 0,
    });
    expect(body.workspace.actions.some((action: any) => action.project === "dash-proj")).toBe(true);
    expect(Array.isArray(body.workspace.activity)).toBe(true);
  });

  it("GET /api/actions returns a limited workspace action queue", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "action-route-proj", type: "product" }),
    });

    const res = await fetch(`${baseUrl}/api/actions?limit=1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      project: "action-route-proj",
      projectType: "product",
      projectStatus: "empty",
      score: 0,
      tone: "primary",
    });
    expect(String(body[0].prompt).length).toBeGreaterThan(20);
  });

  it("GET /api/activity returns a limited artifact and session feed", async () => {
    await saveArtifact({
      project: "activity-route-proj",
      type: "markdown",
      filename: "note.md",
      content: "# Note",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await recordProjectSession("activity-route-proj", "pi-session-route-activity", "2026-01-02T00:00:00.000Z");

    const res = await fetch(`${baseUrl}/api/activity?limit=2`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body.some((item: any) => item.kind === "artifact" && item.file === "note.md")).toBe(true);
    expect(body.some((item: any) => item.kind === "session" && item.sessionId === "pi-session-route-activity")).toBe(true);
  });

  it("GET /api/starters returns production-oriented starter templates", async () => {
    const res = await fetch(`${baseUrl}/api/starters`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.length).toBeGreaterThanOrEqual(5);
    expect(body[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      mode: expect.stringMatching(/create|work/),
      prompt: expect.stringContaining("保存"),
    });
  });

  it("GET /api/starters/:id returns one starter or 404", async () => {
    const ok = await fetch(`${baseUrl}/api/starters/product-plan`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      id: "product-plan",
      projectType: "product",
      mode: "work",
    });

    const missing = await fetch(`${baseUrl}/api/starters/not-here`);
    expect(missing.status).toBe(404);
  });

  it("GET /api/projects/:name/sessions returns project session records", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "session-route-proj", type: "create" }),
    });
    await recordProjectSession("session-route-proj", "pi-session-route-1", "2026-01-01T00:00:00.000Z");

    const res = await fetch(`${baseUrl}/api/projects/session-route-proj/sessions`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "pi-session-route-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(body[0].label).toContain("pi-session");
  });

  it("GET /api/download streams a saved artifact as an attachment", async () => {
    await saveArtifact({
      project: "download-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Brief\nhello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/download?project=download-proj&file=brief.md`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("# Brief\nhello");
  });

  it("GET /api/download rejects missing or unsafe artifacts", async () => {
    const res = await fetch(`${baseUrl}/api/download?project=download-proj&file=..%2Fsecret.md`);
    expect(res.status).toBe(404);
  });

  it("GET /api/project/:name/details returns artifact metadata", async () => {
    await saveArtifact({
      project: "detail-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Brief",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const details = await (await fetch(`${baseUrl}/api/project/detail-proj/details`)).json();
    const legacy = await (await fetch(`${baseUrl}/api/project/detail-proj`)).json();

    expect(details[0]).toMatchObject({
      file: "brief.md",
      type: "markdown",
      size: "# Brief".length,
    });
    expect(legacy).toEqual(["brief.md"]);
  });

  it("PUT /api/project/:name renames a project", async () => {
    await saveArtifact({
      project: "rename-route-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Rename",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/project/rename-route-proj`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed-route-proj" }),
    });
    const oldDetails = await fetch(`${baseUrl}/api/project/rename-route-proj/details`);
    const newArtifact = await (await fetch(`${baseUrl}/api/artifact?project=renamed-route-proj&file=brief.md`)).json();
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "renamed-route-proj",
      name: "renamed-route-proj",
    });
    expect(await oldDetails.json()).toEqual([]);
    expect(newArtifact.content).toBe("# Rename");
    expect(projects.some((item: any) => item.name === "rename-route-proj")).toBe(false);
    expect(projects.some((item: any) => item.name === "renamed-route-proj")).toBe(true);
  });

  it("PUT /api/project/:name returns 409 when target project exists", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "rename-conflict-a", type: "create" }),
    });
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "rename-conflict-b", type: "create" }),
    });

    const res = await fetch(`${baseUrl}/api/project/rename-conflict-a`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "rename-conflict-b" }),
    });

    expect(res.status).toBe(409);
  });

  it("PATCH /api/project/:name/pin updates pinned state and dashboard ordering", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pin-old-proj", type: "create" }),
    });
    await saveArtifact({
      project: "pin-recent-proj",
      type: "markdown",
      filename: "recent.md",
      content: "# Recent",
      timestamp: "2026-06-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/project/pin-old-proj/pin`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "pin-old-proj",
      pinned: true,
    });
    expect(projects.find((item: any) => item.name === "pin-old-proj")?.pinned).toBe(true);
    expect(dashboard.workspace.projects[0]).toMatchObject({
      name: "pin-old-proj",
      pinned: true,
    });
  });

  it("PATCH /api/project/:name/type updates delivery model and readiness", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "type-route-proj", type: "product" }),
    });

    const res = await fetch(`${baseUrl}/api/project/type-route-proj/type`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "analysis" }),
    });
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    const deliverables = await (await fetch(`${baseUrl}/api/project/type-route-proj/deliverables`)).json();
    const readiness = await (await fetch(`${baseUrl}/api/project/type-route-proj/readiness`)).json();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "type-route-proj",
      type: "analysis",
    });
    expect(projects.find((item: any) => item.name === "type-route-proj")?.type).toBe("analysis");
    expect(deliverables.items.some((item: any) => item.id === "report")).toBe(true);
    expect(deliverables.items.some((item: any) => item.id === "prd")).toBe(false);
    expect(readiness).toMatchObject({
      project: "type-route-proj",
      type: "analysis",
    });
  });

  it("PATCH /api/project/:name/tags updates tags and search", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tag-route-proj", type: "product" }),
    });

    const res = await fetch(`${baseUrl}/api/project/tag-route-proj/tags`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: ["客户A", "#交付", "交付"] }),
    });
    const body = await res.json();
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    const search = await (await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("客户A")}`)).json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      name: "tag-route-proj",
      tags: ["客户A", "交付"],
    });
    expect(projects.find((item: any) => item.name === "tag-route-proj")?.tags).toEqual(["客户A", "交付"]);
    expect(search[0]).toMatchObject({
      type: "project",
      project: "tag-route-proj",
    });
  });

  it("GET and PUT /api/project/:name/brief updates reusable project context", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "brief-route-proj", type: "brief" }),
    });

    const empty = await fetch(`${baseUrl}/api/project/brief-route-proj/brief`);
    const res = await fetch(`${baseUrl}/api/project/brief-route-proj/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Prepare investor update",
        audience: "Seed investors",
        background: "Revenue is growing",
        constraints: "One page",
        acceptance: "Has metrics and asks",
      }),
    });
    const saved = await res.json();
    const loaded = await (await fetch(`${baseUrl}/api/project/brief-route-proj/brief`)).json();
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();

    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ goal: "", audience: "" });
    expect(res.status).toBe(200);
    expect(saved).toMatchObject({
      goal: "Prepare investor update",
      audience: "Seed investors",
      acceptance: "Has metrics and asks",
    });
    expect(loaded).toMatchObject(saved);
    expect(projects.find((item: any) => item.name === "brief-route-proj")?.type).toBe("brief");
  });

  it("GET /api/project/:name/deliverables returns delivery progress", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "delivery-proj", type: "product" }),
    });
    await saveArtifact({
      project: "delivery-proj",
      type: "markdown",
      filename: "prd.md",
      content: "# PRD",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/project/delivery-proj/deliverables`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.done).toBeGreaterThanOrEqual(1);
    expect(body.items.some((item: any) => item.done && item.matchedFile === "prd.md")).toBe(true);
    expect(body.items.find((item: any) => item.id === "prd")?.prompt).toContain("保存");
  });

  it("GET /api/project/:name/readiness returns quality-backed next actions", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ready-proj", type: "product" }),
    });
    await saveArtifact({
      project: "ready-proj",
      type: "markdown",
      filename: "prd.md",
      content: "# PRD\n\nToo short.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/project/ready-proj/readiness`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      project: "ready-proj",
      status: "needs-work",
      artifactCount: 1,
      deliverables: {
        total: 2,
      },
    });
    expect(body.quality[0]).toMatchObject({
      file: "prd.md",
      status: "needs-work",
    });
    expect(body.actions.length).toBeGreaterThan(0);
    expect(body.actions.some((action: any) => String(action.prompt).includes("保存"))).toBe(true);
  });

  it("GET /api/project/:name/delivery-check returns preflight blockers", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "delivery-check-proj", type: "product" }),
    });

    const res = await fetch(`${baseUrl}/api/project/delivery-check-proj/delivery-check`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      project: "delivery-check-proj",
      ready: false,
      status: "empty",
      blockers: expect.any(Array),
      warnings: expect.any(Array),
    });
    expect(body.blockers.some((item: any) => item.kind === "empty")).toBe(true);
    expect(body.blockers.every((item: any) => String(item.prompt || "").length > 20)).toBe(true);
  });

  it("GET and POST /api/project/:name/handoff builds and saves a delivery summary", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "handoff-proj", type: "product" }),
    });
    await saveArtifact({
      project: "handoff-proj",
      type: "markdown",
      filename: "prd.md",
      content: [
        "# PRD",
        "## 背景",
        "这个产品方案包含目标、范围、流程、指标和风险，可供团队推进。",
        "## 方案",
        "它描述核心场景、约束、用户路径和验收标准，方便继续拆解执行。",
        "## 结论",
        "下一步是确认优先级和负责人，并保持交付物持续更新。",
      ].join("\n\n"),
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const preview = await fetch(`${baseUrl}/api/project/handoff-proj/handoff`);
    const previewBody = await preview.json();
    const saved = await fetch(`${baseUrl}/api/project/handoff-proj/handoff`, { method: "POST" });
    const savedBody = await saved.json();
    const artifact = await (await fetch(`${baseUrl}/api/artifact?project=handoff-proj&file=handoff-summary.md`)).json();

    expect(preview.status).toBe(200);
    expect(previewBody).toMatchObject({
      project: "handoff-proj",
      file: "handoff-summary.md",
    });
    expect(previewBody.content).toContain("# handoff-proj 交接摘要");
    expect(previewBody.content).toContain("## 交付清单");
    expect(saved.status).toBe(201);
    expect(savedBody.artifact).toMatchObject({
      file: "handoff-summary.md",
      type: "markdown",
    });
    expect(artifact.content).toContain("## 产物清单");
  });

  it("PUT /api/artifact edits an existing artifact", async () => {
    await saveArtifact({
      project: "edit-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Draft",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/artifact`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "edit-proj",
        file: "brief.md",
        content: "# Edited",
      }),
    });
    const edited = await (await fetch(`${baseUrl}/api/artifact?project=edit-proj&file=brief.md`)).json();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      project: "edit-proj",
      file: "brief.md",
      artifact: {
        file: "brief.md",
        type: "markdown",
        size: "# Edited".length,
      },
    });
    expect(edited.content).toBe("# Edited");
  });

  it("DELETE /api/artifact moves an artifact to project trash", async () => {
    await saveArtifact({
      project: "trash-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Trash",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/artifact`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "trash-proj",
        file: "brief.md",
      }),
    });
    const missing = await fetch(`${baseUrl}/api/artifact?project=trash-proj&file=brief.md`);
    const files = await (await fetch(`${baseUrl}/api/project/trash-proj/details`)).json();
    const versions = await (await fetch(`${baseUrl}/api/artifact/history?project=trash-proj&file=brief.md`)).json();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      project: "trash-proj",
      file: "brief.md",
      trashed: {
        file: "brief.md",
        size: "# Trash".length,
      },
    });
    expect(missing.status).toBe(404);
    expect(files.some((item: any) => item.file === "brief.md")).toBe(false);
    expect(versions).toHaveLength(1);
  });

  it("GET and POST /api/project/:name/trash lists and restores artifacts", async () => {
    await saveArtifact({
      project: "restore-trash-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Restore",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const trashed = await fetch(`${baseUrl}/api/artifact`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "restore-trash-proj", file: "brief.md" }),
    }).then((r) => r.json());

    const trash = await fetch(`${baseUrl}/api/project/restore-trash-proj/trash`);
    const trashBody = await trash.json();
    const restored = await fetch(`${baseUrl}/api/project/restore-trash-proj/trash/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trashedFile: trashed.trashed.trashedFile }),
    });
    const artifact = await (await fetch(`${baseUrl}/api/artifact?project=restore-trash-proj&file=brief.md`)).json();
    const emptyTrash = await (await fetch(`${baseUrl}/api/project/restore-trash-proj/trash`)).json();

    expect(trash.status).toBe(200);
    expect(trashBody[0]).toMatchObject({
      file: "brief.md",
      trashedFile: trashed.trashed.trashedFile,
      type: "markdown",
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      project: "restore-trash-proj",
      artifact: {
        file: "brief.md",
        type: "markdown",
      },
    });
    expect(artifact.content).toBe("# Restore");
    expect(emptyTrash).toEqual([]);
  });

  it("POST /api/project/:name/trash/restore returns 409 when active file exists", async () => {
    await saveArtifact({
      project: "restore-conflict-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Old",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const trashed = await fetch(`${baseUrl}/api/artifact`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "restore-conflict-proj", file: "brief.md" }),
    }).then((r) => r.json());
    await saveArtifact({
      project: "restore-conflict-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# New",
      timestamp: "2026-01-02T00:00:00.000Z",
    });

    const restore = await fetch(`${baseUrl}/api/project/restore-conflict-proj/trash/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trashedFile: trashed.trashed.trashedFile }),
    });

    expect(restore.status).toBe(409);
    expect(await restore.json()).toMatchObject({
      error: expect.stringContaining("already exists"),
    });
  });

  it("POST /api/artifact creates a manual artifact and rejects duplicates", async () => {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "manual-proj", type: "product" }),
    });

    const create = await fetch(`${baseUrl}/api/artifact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "manual-proj",
        file: "manual.md",
        content: "# Manual\n\n## 下一步\n\n可以继续打磨。",
      }),
    });
    const duplicate = await fetch(`${baseUrl}/api/artifact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "manual-proj",
        file: "manual.md",
        content: "# Duplicate",
      }),
    });
    const saved = await (await fetch(`${baseUrl}/api/artifact?project=manual-proj&file=manual.md`)).json();

    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({
      project: "manual-proj",
      file: "manual.md",
      artifact: {
        file: "manual.md",
        type: "markdown",
      },
    });
    expect(saved.content).toContain("# Manual");
    expect(duplicate.status).toBe(409);
  });

  it("GET /api/artifact/quality returns artifact readiness signals", async () => {
    await saveArtifact({
      project: "quality-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Brief\n\nToo short.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/artifact/quality?project=quality-proj&file=brief.md`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.quality).toMatchObject({
      status: "needs-work",
      score: expect.any(Number),
    });
    expect(body.quality.issues.length).toBeGreaterThan(0);
  });

  it("GET and POST /api/artifact/history exposes versions and restores them", async () => {
    await saveArtifact({
      project: "history-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# V1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await fetch(`${baseUrl}/api/artifact`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "history-proj", file: "brief.md", content: "# V2" }),
    });

    const versions = await (await fetch(`${baseUrl}/api/artifact/history?project=history-proj&file=brief.md`)).json();
    const content = await (await fetch(`${baseUrl}/api/artifact/history/content?project=history-proj&file=brief.md&version=${encodeURIComponent(versions[0].id)}`)).json();
    const restore = await fetch(`${baseUrl}/api/artifact/history/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "history-proj", file: "brief.md", version: versions[0].id }),
    });
    const restored = await (await fetch(`${baseUrl}/api/artifact?project=history-proj&file=brief.md`)).json();

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ file: "brief.md", size: "# V1".length });
    expect(content).toMatchObject({ content: "# V1" });
    expect(restore.status).toBe(200);
    expect(restored.content).toBe("# V1");
  });

  it("PUT /api/artifact rejects missing or unsafe artifacts", async () => {
    const missing = await fetch(`${baseUrl}/api/artifact`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "none", file: "missing.md", content: "nope" }),
    });
    const unsafe = await fetch(`${baseUrl}/api/artifact`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "none", file: "../secret.md", content: "nope" }),
    });

    expect(missing.status).toBe(404);
    expect(unsafe.status).toBe(404);
  });

  it("GET /api/search returns project and artifact hits", async () => {
    await saveArtifact({
      project: "search-proj",
      type: "markdown",
      filename: "insight.md",
      content: "The durable phrase is blue comet.",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const byProject = await (await fetch(`${baseUrl}/api/search?q=search-proj`)).json();
    const byContent = await (await fetch(`${baseUrl}/api/search?q=blue%20comet`)).json();
    const empty = await (await fetch(`${baseUrl}/api/search?q=`)).json();

    expect(byProject.some((item: any) => item.type === "project" && item.project === "search-proj")).toBe(true);
    expect(byContent[0]).toMatchObject({
      type: "artifact",
      project: "search-proj",
      file: "insight.md",
    });
    expect(byContent[0].snippet).toContain("blue comet");
    expect(empty).toEqual([]);
  });

  it("GET /api/project/:name/export returns a project zip", async () => {
    await saveArtifact({
      project: "export-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Export",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/project/export-proj/export`);
    const body = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(body.readUInt32LE(0)).toBe(0x04034b50);
    expect(body.includes(Buffer.from("artifacts/brief.md"))).toBe(true);
  });

  it("GET /api/project/:name/delivery returns a clean delivery zip", async () => {
    await saveArtifact({
      project: "delivery-zip-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Delivery",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/project/delivery-zip-proj/delivery`);
    const body = Buffer.from(await res.arrayBuffer());
    const entries = readZip(body);
    const paths = entries.map((entry) => entry.path);
    const manifest = JSON.parse(entries.find((entry) => entry.path === "manifest.json")?.data.toString("utf-8") || "{}");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("content-disposition")).toContain("delivery-zip-proj-delivery.zip");
    expect(paths).toContain("README.md");
    expect(paths).toContain("manifest.json");
    expect(paths).toContain("artifacts/brief.md");
    expect(paths.some((path) => path.startsWith("history/"))).toBe(false);
    expect(manifest).toMatchObject({
      project: "delivery-zip-proj",
      readiness: {
        status: expect.any(String),
        score: expect.any(Number),
      },
    });
  });

  it("POST /api/projects/import imports an exported project zip", async () => {
    await saveArtifact({
      project: "roundtrip-proj",
      type: "markdown",
      filename: "brief.md",
      content: "# Roundtrip",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const exported = Buffer.from(await (await fetch(`${baseUrl}/api/project/roundtrip-proj/export`)).arrayBuffer());

    const res = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ zipBase64: exported.toString("base64") }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.project.name).toBe("roundtrip-proj-2");
    expect(body.imported.artifacts).toBe(1);
    expect(await (await fetch(`${baseUrl}/api/artifact?project=roundtrip-proj-2&file=brief.md`)).json()).toMatchObject({
      content: "# Roundtrip",
    });
  });
});
