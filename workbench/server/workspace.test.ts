/**
 * workspace.test.ts — workspace.ts 单元测试
 *
 * 覆盖: saveArtifact、readArtifact、listProjects、listArtifacts 的正常流程和边界情况。
 * 使用临时目录隔离每个测试,避免污染真实 workspace。
 *
 * 策略: vi.resetModules() + 动态 import,使每个 describe 块获得以 tmpDir 为根的新模块实例。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  it("listProjects includes saved project", async () => {
    const project = uid();
    await ws.saveArtifact({ project, type: "csv", filename: "data.csv", content: "a,b", timestamp: TS });
    const projects = await ws.listProjects();
    expect(projects.some(p => p.name === project)).toBe(true);
  });

  it("listArtifacts returns [] for missing project", async () => {
    expect(await ws.listArtifacts("nonexistent-xyz-" + uid())).toEqual([]);
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
