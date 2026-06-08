import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import workbenchExtension from "../../pi-ext/workbench/index.ts";

describe("workbench extension", () => {
  afterEach(() => {
    delete (globalThis as any).__workbenchSessionModes;
    delete (globalThis as any).__workbenchSessionProjects;
    delete process.env.WORKBENCH_WORKSPACE;
  });

  it("returns systemPrompt from before_agent_start and looks up mode by Pi session id", async () => {
    const modes = new Map([["pi-session-1", "work"]]);
    (globalThis as any).__workbenchSessionModes = modes;
    const handlers = new Map<string, Function>();
    const pi = {
      registerTool: () => {},
      on: (event: string, handler: Function) => handlers.set(event, handler),
    };

    workbenchExtension(pi as any);

    const result = await handlers.get("before_agent_start")!(
      { systemPrompt: "BASE" },
      { sessionManager: { getSessionId: () => "pi-session-1" } },
    );

    expect(result).toHaveProperty("systemPrompt");
    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("工作模式");
  });

  it("injects the project brief for the current session", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "workbench-ext-"));
    process.env.WORKBENCH_WORKSPACE = tmpDir;
    await mkdir(join(tmpDir, "brief-proj"), { recursive: true });
    await writeFile(join(tmpDir, "brief-proj", "meta.json"), JSON.stringify({
      name: "brief-proj",
      type: "product",
      brief: {
        goal: "Prepare launch plan",
        audience: "Product team",
        constraints: "Use a crisp checklist",
        acceptance: "Ready for Monday review",
      },
    }));
    (globalThis as any).__workbenchSessionModes = new Map([["pi-session-brief", "work"]]);
    (globalThis as any).__workbenchSessionProjects = new Map([["pi-session-brief", "brief-proj"]]);
    const handlers = new Map<string, Function>();
    const pi = {
      registerTool: () => {},
      on: (event: string, handler: Function) => handlers.set(event, handler),
    };

    try {
      vi.resetModules();
      const { default: freshWorkbenchExtension } = await import("../../pi-ext/workbench/index.ts");
      freshWorkbenchExtension(pi as any);
      const result = await handlers.get("before_agent_start")!(
        { systemPrompt: "BASE" },
        { sessionManager: { getSessionId: () => "pi-session-brief" } },
      );

      expect(result.systemPrompt).toContain("项目简报");
      expect(result.systemPrompt).toContain("Prepare launch plan");
      expect(result.systemPrompt).toContain("Product team");
      expect(result.systemPrompt).toContain("Ready for Monday review");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
