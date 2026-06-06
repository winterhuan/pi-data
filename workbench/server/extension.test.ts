import { describe, expect, it } from "vitest";
import workbenchExtension from "../../pi-ext/workbench/index.ts";

describe("workbench extension", () => {
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
});
