import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createProject, projectDir } from "./workspace.ts";

describe("project skills", () => {
  const temps: string[] = [];

  afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
    delete process.env.WORKBENCH_WORKSPACE;
  });

  it("load through DefaultResourceLoader without invalid-name diagnostics", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "resource-loader-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "resource-loader-agent-"));
    temps.push(workspace, agentDir);
    process.env.WORKBENCH_WORKSPACE = workspace;

    await createProject("loader-proj");
    const cwd = projectDir("loader-proj");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const result = loader.getSkills();
    expect(result.skills.some((s) => s.name === "write-scene")).toBe(true);
    expect(result.diagnostics.filter((d) => d.message.includes("invalid characters"))).toEqual([]);
  });
});
