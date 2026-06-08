/**
 * workspace.test.ts — workspace.ts 单元测试
 *
 * 覆盖: saveArtifact、readArtifact、listProjects、listArtifacts 的正常流程和边界情况。
 * 使用临时目录隔离每个测试,避免污染真实 workspace。
 *
 * 策略: vi.resetModules() + 动态 import,使每个 describe 块获得以 tmpDir 为根的新模块实例。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readZip } from "./zip.ts";

describe("workspace", () => {
  let tmpDir: string;
  let ws: typeof import("./workspace.ts");

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    vi.resetModules();
    process.env.WORKBENCH_WORKSPACE = tmpDir;
    ws = await import("./workspace.ts");
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.WORKBENCH_WORKSPACE;
    vi.resetModules();
  });

  const uid = () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const TS = "2026-01-01T00:00:00Z";

  it("saveArtifact creates project and artifact file", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "hello.md", content: "# Hello", timestamp: TS });
    const files = await ws.listArtifacts(project);
    expect(files).toContain("hello.md");
  });

  it("readArtifact returns saved content", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "test.md", content: "world", timestamp: TS });
    const content = await ws.readArtifact(project, "test.md");
    expect(content).toBe("world");
  });

  it("updateArtifact edits an existing artifact and refreshes project metadata", async () => {
    const project = uid();
    const editedAt = "2026-02-01T00:00:00Z";
    await ws.saveArtifact({ project, type: "markdown", filename: "brief.md", content: "# Draft", timestamp: TS });

    const detail = await ws.updateArtifact({
      project,
      filename: "brief.md",
      content: "# Edited",
      timestamp: editedAt,
    });

    expect(detail).toMatchObject({
      file: "brief.md",
      type: "markdown",
      size: "# Edited".length,
    });
    expect(await ws.readArtifact(project, "brief.md")).toBe("# Edited");
    const entry = (await ws.listProjects()).find((p) => p.name === project);
    expect(entry).toMatchObject({ lastUpdated: editedAt, type: "markdown" });
  });

  it("createArtifact creates a manual artifact without overwriting existing files", async () => {
    const project = uid();
    await ws.createProject(project, "product");

    const detail = await ws.createArtifact({
      project,
      filename: "manual.md",
      content: "# Manual",
      timestamp: TS,
    });

    expect(detail).toMatchObject({
      file: "manual.md",
      type: "markdown",
      size: "# Manual".length,
    });
    expect(await ws.readArtifact(project, "manual.md")).toBe("# Manual");
    await expect(ws.createArtifact({
      project,
      filename: "manual.md",
      content: "# Overwrite",
      timestamp: TS,
    })).rejects.toThrow("already exists");
  });

  it("trashArtifact moves an artifact out of active project files", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "brief.md", content: "# Trash me", timestamp: TS });

    const trashed = await ws.trashArtifact({
      project,
      filename: "brief.md",
      timestamp: "2026-02-01T00:00:00Z",
    });

    expect(trashed).toMatchObject({
      file: "brief.md",
      size: "# Trash me".length,
      trashedAt: "2026-02-01T00:00:00Z",
    });
    expect(await ws.listArtifacts(project)).not.toContain("brief.md");
    await expect(ws.readArtifact(project, "brief.md")).rejects.toThrow();
    await expect(stat(join(tmpDir, project, "trash", "artifacts", trashed.trashedFile))).resolves.toMatchObject({
      size: "# Trash me".length,
    });
    expect(await ws.listArtifactVersions(project, "brief.md")).toHaveLength(1);
  });

  it("listTrashedArtifacts and restoreTrashedArtifact recover a trashed artifact", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "restore-me.md", content: "# Restore", timestamp: TS });
    const trashed = await ws.trashArtifact({
      project,
      filename: "restore-me.md",
      timestamp: "2026-02-01T00:00:00Z",
    });

    const trash = await ws.listTrashedArtifacts(project);
    expect(trash[0]).toMatchObject({
      file: "restore-me.md",
      trashedFile: trashed.trashedFile,
      type: "markdown",
    });

    const restored = await ws.restoreTrashedArtifact({
      project,
      trashedFile: trashed.trashedFile,
      timestamp: "2026-03-01T00:00:00Z",
    });

    expect(restored).toMatchObject({
      file: "restore-me.md",
      type: "markdown",
      size: "# Restore".length,
    });
    expect(await ws.readArtifact(project, "restore-me.md")).toBe("# Restore");
    expect(await ws.listTrashedArtifacts(project)).toEqual([]);
  });

  it("restoreTrashedArtifact does not overwrite an active artifact", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "same.md", content: "# Old", timestamp: TS });
    const trashed = await ws.trashArtifact({
      project,
      filename: "same.md",
      timestamp: "2026-02-01T00:00:00Z",
    });
    await ws.saveArtifact({ project, type: "markdown", filename: "same.md", content: "# New", timestamp: "2026-02-02T00:00:00Z" });

    await expect(ws.restoreTrashedArtifact({
      project,
      trashedFile: trashed.trashedFile,
      timestamp: "2026-03-01T00:00:00Z",
    })).rejects.toThrow("already exists");
    expect(await ws.readArtifact(project, "same.md")).toBe("# New");
    expect(await ws.listTrashedArtifacts(project)).toHaveLength(1);
  });

  it("records artifact history and restores an older version", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "brief.md", content: "# V1", timestamp: TS });
    await ws.updateArtifact({
      project,
      filename: "brief.md",
      content: "# V2",
      timestamp: "2026-02-01T00:00:00Z",
    });

    const versions = await ws.listArtifactVersions(project, "brief.md");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      file: "brief.md",
      size: "# V1".length,
    });
    expect(await ws.readArtifactVersion(project, "brief.md", versions[0].id)).toBe("# V1");

    await ws.restoreArtifactVersion({
      project,
      filename: "brief.md",
      versionId: versions[0].id,
      timestamp: "2026-03-01T00:00:00Z",
    });

    expect(await ws.readArtifact(project, "brief.md")).toBe("# V1");
    expect(await ws.listArtifactVersions(project, "brief.md")).toHaveLength(2);
  });

  it("listProjects includes saved project", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "csv", filename: "data.csv", content: "a,b", timestamp: TS });
    const projects = await ws.listProjects();
    expect(projects.some(p => p.name === project)).toBe(true);
  });

  it("listProjects tolerates a UTF-8 BOM in index.json", async () => {
    await writeFile(join(tmpDir, "index.json"), "\uFEFF" + JSON.stringify([
      { id: "bom-proj", name: "bom-proj", type: "demo", lastUpdated: TS },
    ]));

    expect((await ws.listProjects())[0]).toMatchObject({ name: "bom-proj" });
  });

  it("listProjects tolerates a single-object index.json", async () => {
    await writeFile(join(tmpDir, "index.json"), JSON.stringify(
      { id: "single-proj", name: "single-proj", type: "demo", lastUpdated: TS },
    ));

    expect(await ws.listProjects()).toHaveLength(1);
    expect((await ws.listProjects())[0]).toMatchObject({ name: "single-proj" });
  });

  it("listArtifacts returns [] for missing project", async () => {
    expect(await ws.listArtifacts("nonexistent-xyz-" + uid())).toEqual([]);
  });

  it("listArtifactDetails returns typed metadata for saved artifacts", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "brief.md", content: "# Hello", timestamp: TS });
    await ws.saveArtifact({ project, type: "csv", filename: "table.csv", content: "a,b", timestamp: TS });

    const details = await ws.listArtifactDetails(project);

    expect(details.map((item) => item.file).sort()).toEqual(["brief.md", "table.csv"]);
    expect(details.find((item) => item.file === "brief.md")).toMatchObject({
      type: "markdown",
      size: "# Hello".length,
    });
    expect(details.find((item) => item.file === "table.csv")?.type).toBe("csv");
    expect(details.every((item) => item.updatedAt)).toBe(true);
  });

  it("getProjectDeliverables reports project delivery progress", async () => {
    const project = uid();
    await ws.createProject(project, "product");
    expect(await ws.getProjectDeliverables(project)).toMatchObject({
      done: 0,
      total: 2,
      percent: 0,
    });

    await ws.saveArtifact({
      project,
      type: "markdown",
      filename: "prd.md",
      content: "# PRD",
      timestamp: TS,
    });

    const deliverables = await ws.getProjectDeliverables(project);
    expect(deliverables.done).toBeGreaterThanOrEqual(1);
    expect(deliverables.items.some((item) => item.done && item.matchedFile === "prd.md")).toBe(true);
    expect(deliverables.items.find((item) => item.id === "prd")?.prompt).toContain("保存");
  });

  it("getProjectReadiness recommends the next production action", async () => {
    const project = uid();
    await ws.createProject(project, "product");

    const empty = await ws.getProjectReadiness(project);
    expect(empty).toMatchObject({
      project,
      status: "empty",
      artifactCount: 0,
      score: 0,
    });
    expect(empty.actions[0]).toMatchObject({
      tone: "primary",
    });
    expect(empty.actions[0].prompt).toContain("保存");

    await ws.saveArtifact({
      project,
      type: "markdown",
      filename: "prd.md",
      content: "# PRD\n\n太短。",
      timestamp: TS,
    });

    const readiness = await ws.getProjectReadiness(project);
    expect(readiness.status).toBe("needs-work");
    expect(readiness.artifactCount).toBe(1);
    expect(readiness.quality[0]).toMatchObject({
      file: "prd.md",
      status: "needs-work",
    });
    expect(readiness.actions.some((action) => action.id === "deliverable-risks")).toBe(true);
    expect(readiness.actions.some((action) => action.file === "prd.md" && action.tone === "warning")).toBe(true);
  });

  it("getDeliveryCheck reports blockers and ready packages", async () => {
    const blockedProject = uid();
    await ws.createProject(blockedProject, "product");

    const blocked = await ws.getDeliveryCheck(blockedProject, "2026-02-01T00:00:00.000Z");
    expect(blocked).toMatchObject({
      project: blockedProject,
      ready: false,
      status: "empty",
      checkedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(blocked.blockers.some((item) => item.kind === "empty")).toBe(true);
    expect(blocked.blockers.some((item) => item.kind === "missing-deliverable")).toBe(true);
    expect(blocked.blockers.every((item) => String(item.prompt || "").length > 20)).toBe(true);

    const readyProject = uid();
    await ws.createProject(readyProject, "create");
    await ws.saveArtifact({
      project: readyProject,
      type: "markdown",
      filename: "main.md",
      content: [
        "# Main",
        "## 背景",
        "这个主文档面向真实交付，描述目标、受众、范围、流程、指标和风险。",
        "它包含足够的上下文，用于团队评审、执行拆解和验收沟通。",
        "## 方案",
        "我们会定义核心场景、用户路径、关键约束、边界条件和成功指标。",
        "每个模块都应该有可验证的输入输出，并且能够被后续任务追踪。",
        "## 结论",
        "下一步是确认优先级、风险和验收标准，然后保存为可交付文档。",
      ].join("\n\n"),
      timestamp: TS,
    });
    await ws.saveArtifact({
      project: readyProject,
      type: "json",
      filename: "data.json",
      content: JSON.stringify({ metrics: [{ name: "activation", value: 0.42 }] }),
      timestamp: TS,
    });

    const ready = await ws.getDeliveryCheck(readyProject, "2026-02-02T00:00:00.000Z");
    expect(ready).toMatchObject({
      project: readyProject,
      ready: true,
      status: "ready",
      blockers: [],
      checkedAt: "2026-02-02T00:00:00.000Z",
    });
  });

  it("listWorkspaceActions aggregates next actions across projects", async () => {
    const emptyProject = uid();
    const draftProject = uid();
    await ws.createProject(emptyProject, "product");
    await ws.createProject(draftProject, "product");
    await ws.saveArtifact({
      project: draftProject,
      type: "markdown",
      filename: "prd.md",
      content: "# PRD\n\nToo short.",
      timestamp: TS,
    });

    const actions = await ws.listWorkspaceActions(50);
    const emptyAction = actions.find((action) => action.project === emptyProject && action.projectStatus === "empty");
    const draftAction = actions.find((action) => action.project === draftProject && action.file === "prd.md");

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.length).toBeLessThanOrEqual(50);
    expect(emptyAction).toMatchObject({
      project: emptyProject,
      projectType: "product",
      score: expect.any(Number),
    });
    expect(String(emptyAction?.prompt || "").length).toBeGreaterThan(20);
    expect(draftAction).toMatchObject({
      project: draftProject,
      projectStatus: "needs-work",
      tone: "warning",
    });
  });

  it("listWorkspaceActivity aggregates recent artifacts and sessions", async () => {
    const project = uid();
    await ws.saveArtifact({
      project,
      type: "markdown",
      filename: "activity.md",
      content: "# Activity",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await ws.recordProjectSession(project, "pi-session-activity-1", "2026-01-02T00:00:00.000Z");

    const activity = await ws.listWorkspaceActivity(10);
    const artifact = activity.find((item) => item.kind === "artifact" && item.project === project && item.file === "activity.md");
    const session = activity.find((item) => item.kind === "session" && item.project === project && item.sessionId === "pi-session-activity-1");

    expect(artifact).toMatchObject({
      title: "activity.md",
      type: "markdown",
      subtitle: expect.stringContaining("markdown"),
    });
    expect(session).toMatchObject({
      title: expect.any(String),
      subtitle: "历史会话",
      timestamp: "2026-01-02T00:00:00.000Z",
    });
    expect(activity).toEqual([...activity].sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.project.localeCompare(b.project) || a.title.localeCompare(b.title)));
  });

  it("createDeliveryPackage builds a clean handoff zip", async () => {
    const project = uid();
    await ws.saveArtifact({
      project,
      type: "markdown",
      filename: "brief.md",
      content: "# Brief",
      timestamp: TS,
    });

    const bundle = await ws.createDeliveryPackage(project, "2026-02-01T00:00:00.000Z");
    const entries = readZip(bundle.zip);
    const paths = entries.map((entry) => entry.path);
    const manifest = JSON.parse(entries.find((entry) => entry.path === "manifest.json")?.data.toString("utf-8") || "{}");

    expect(bundle.filename).toBe(`${project}-delivery.zip`);
    expect(paths).toContain("README.md");
    expect(paths).toContain("manifest.json");
    expect(paths).toContain("artifacts/brief.md");
    expect(paths.some((path) => path.startsWith("history/"))).toBe(false);
    expect(manifest).toMatchObject({
      project,
      generatedAt: "2026-02-01T00:00:00.000Z",
      readiness: {
        status: expect.any(String),
        score: expect.any(Number),
      },
      deliveryCheck: {
        ready: false,
        checkedAt: "2026-02-01T00:00:00.000Z",
      },
    });
  });

  it("searchWorkspace finds projects, artifact names, and artifact content", async () => {
    const project = uid();
    await ws.saveArtifact({
      project,
      type: "markdown",
      filename: "research-note.md",
      content: "This note contains a rare keyword: polar-lantern.",
      timestamp: TS,
    });

    const projectResults = await ws.searchWorkspace(project.slice(0, 8));
    const fileResults = await ws.searchWorkspace("research");
    const contentResults = await ws.searchWorkspace("polar-lantern");

    expect(projectResults.some((item) => item.type === "project" && item.project === project)).toBe(true);
    expect(fileResults.some((item) => item.type === "artifact" && item.file === "research-note.md")).toBe(true);
    expect(contentResults[0]).toMatchObject({
      type: "artifact",
      project,
      file: "research-note.md",
    });
    expect(contentResults[0].snippet).toContain("polar-lantern");
    expect(await ws.searchWorkspace("")).toEqual([]);
  });

  it("exportProject creates a zip with manifest and artifacts", async () => {
    const project = uid();
    await ws.saveArtifact({
      project,
      type: "markdown",
      filename: "brief.md",
      content: "# Export me",
      timestamp: TS,
    });

    const bundle = await ws.exportProject(project);

    expect(bundle.filename).toBe(`${project}.zip`);
    expect(bundle.zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(bundle.zip.includes(Buffer.from("manifest.json"))).toBe(true);
    expect(bundle.zip.includes(Buffer.from("artifacts/brief.md"))).toBe(true);
    expect(bundle.zip.includes(Buffer.from("# Export me"))).toBe(true);
  });

  it("importProjectZip restores an exported project without overwriting existing projects", async () => {
    const project = uid();
    await ws.saveArtifact({
      project,
      type: "markdown",
      filename: "brief.md",
      content: "# Import me",
      timestamp: TS,
    });
    const bundle = await ws.exportProject(project);

    const imported = await ws.importProjectZip(bundle.zip);

    expect(imported.project.name).toBe(`${project}-2`);
    expect(imported.imported.artifacts).toBe(1);
    expect(await ws.readArtifact(imported.project.name, "brief.md")).toBe("# Import me");
  });

  it("renameProject moves the project directory and updates index/meta", async () => {
    const project = uid();
    const renamed = `${project}-renamed`;
    await ws.saveArtifact({
      project,
      type: "markdown",
      filename: "brief.md",
      content: "# Rename",
      timestamp: TS,
    });

    const entry = await ws.renameProject({
      from: project,
      to: renamed,
      timestamp: "2026-04-01T00:00:00Z",
    });

    expect(entry).toMatchObject({
      id: renamed,
      name: renamed,
      lastUpdated: "2026-04-01T00:00:00Z",
    });
    expect(await ws.listArtifacts(project)).toEqual([]);
    expect(await ws.readArtifact(renamed, "brief.md")).toBe("# Rename");
    const projects = await ws.listProjects();
    expect(projects.some((item) => item.name === project)).toBe(false);
    expect(projects.find((item) => item.name === renamed)).toMatchObject({
      id: renamed,
      name: renamed,
    });
  });

  it("renameProject refuses to overwrite an existing project", async () => {
    const source = uid();
    const target = uid();
    await ws.createProject(source, "create");
    await ws.createProject(target, "work");

    await expect(ws.renameProject({
      from: source,
      to: target,
      timestamp: TS,
    })).rejects.toThrow("already exists");
  });

  it("setProjectPinned marks projects and sorts overviews before recent unpinned projects", async () => {
    const oldProject = uid();
    const recentProject = uid();
    await ws.createProject(oldProject, "create");
    await ws.createProject(recentProject, "create");
    await ws.saveArtifact({
      project: recentProject,
      type: "markdown",
      filename: "recent.md",
      content: "# Recent",
      timestamp: "2026-06-01T00:00:00Z",
    });

    const pinned = await ws.setProjectPinned({
      project: oldProject,
      pinned: true,
      timestamp: "2026-06-02T00:00:00Z",
    });
    const overviews = await ws.listProjectOverviews();

    expect(pinned).toMatchObject({
      name: oldProject,
      pinned: true,
    });
    expect((await ws.listProjects()).find((item) => item.name === oldProject)?.pinned).toBe(true);
    expect(overviews[0]).toMatchObject({
      name: oldProject,
      pinned: true,
    });
  });

  it("setProjectType changes the delivery checklist and readiness type", async () => {
    const project = uid();
    await ws.createProject(project, "product");

    const productDeliverables = await ws.getProjectDeliverables(project);
    const updated = await ws.setProjectType({
      project,
      type: "analysis",
      timestamp: "2026-06-03T00:00:00Z",
    });
    const analysisDeliverables = await ws.getProjectDeliverables(project);
    const readiness = await ws.getProjectReadiness(project);

    expect(updated).toMatchObject({
      name: project,
      type: "analysis",
      lastUpdated: "2026-06-03T00:00:00Z",
    });
    expect(productDeliverables.items.some((item) => item.id === "prd")).toBe(true);
    expect(analysisDeliverables.items.some((item) => item.id === "report")).toBe(true);
    expect(analysisDeliverables.items.some((item) => item.id === "prd")).toBe(false);
    expect(readiness.type).toBe("analysis");
    expect((await ws.listProjects()).find((item) => item.name === project)?.type).toBe("analysis");
  });

  it("setProjectTags stores searchable project tags", async () => {
    const project = uid();
    await ws.createProject(project, "product");

    const entry = await ws.setProjectTags({
      project,
      tags: ["客户A", "#交付", "交付", " very long tag name that will be clipped "],
      timestamp: TS,
    });
    const projects = await ws.listProjects();
    const results = await ws.searchWorkspace("客户A");

    expect(entry.tags).toEqual(["客户A", "交付", "very long tag name that"]);
    expect(projects.find((item) => item.name === project)?.tags).toEqual(entry.tags);
    expect(results[0]).toMatchObject({
      type: "project",
      project,
    });
    expect(results[0].subtitle).toContain("#客户A");
  });

  it("setProjectBrief stores reusable project context in meta and refreshes the project", async () => {
    const project = uid();
    await ws.createProject(project, "brief");

    const brief = await ws.setProjectBrief({
      project,
      timestamp: "2026-06-04T00:00:00Z",
      brief: {
        goal: "Ship a board-ready memo",
        audience: "Leadership team",
        background: "Customer churn increased in Q2",
        constraints: "Keep it under two pages",
        acceptance: "Clear recommendation and next steps",
      },
    });

    expect(brief).toMatchObject({
      goal: "Ship a board-ready memo",
      audience: "Leadership team",
      acceptance: "Clear recommendation and next steps",
      updatedAt: "2026-06-04T00:00:00Z",
    });
    expect(await ws.getProjectBrief(project)).toMatchObject({
      background: "Customer churn increased in Q2",
      constraints: "Keep it under two pages",
    });
    expect((await ws.listProjects()).find((item) => item.name === project)).toMatchObject({
      type: "brief",
      lastUpdated: "2026-06-04T00:00:00Z",
    });
  });

  it("readArtifact throws on path traversal in project name", async () => {
    await expect(ws.readArtifact("../../etc", "passwd")).rejects.toThrow();
  });

  it("readArtifact throws on path traversal in filename", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "ok.md", content: "ok", timestamp: TS });
    // safeSeg replaces .. with _, so this resolves to a safe path but won't exist
    await expect(ws.readArtifact(project, "../../etc/passwd")).rejects.toThrow();
  });

  it("updateArtifact rejects missing or unsafe artifact targets", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "ok.md", content: "ok", timestamp: TS });

    await expect(ws.updateArtifact({
      project,
      filename: "missing.md",
      content: "nope",
      timestamp: TS,
    })).rejects.toThrow();
    await expect(ws.updateArtifact({
      project,
      filename: "../secret.md",
      content: "nope",
      timestamp: TS,
    })).rejects.toThrow();
  });

  it("saveArtifact concurrent writes preserve all entries in index", async () => {
    const project = uid();
    const writes = Array.from({ length: 5 }, (_, i) =>
      ws.saveArtifact({ project, type: "markdown", filename: `file${i}.md`, content: `content${i}`, timestamp: new Date().toISOString() })
    );
    await Promise.all(writes);
    const files = await ws.listArtifacts(project);
    expect(files.length).toBe(5);
  });

  it("saveArtifact updates lastUpdated on re-save", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "markdown", filename: "a.md", content: "v1", timestamp: "2026-01-01T00:00:00Z" });
    await ws.saveArtifact({ project, type: "markdown", filename: "b.md", content: "v2", timestamp: "2026-06-01T00:00:00Z" });
    const projects = await ws.listProjects();
    const entry = projects.find(p => p.name === project);
    expect(entry?.lastUpdated).toBe("2026-06-01T00:00:00Z");
  });
});
