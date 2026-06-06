import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const piMock = vi.hoisted(() => {
  const manager = (id: string, cwd: string, path?: string) => ({
    id,
    cwd,
    path,
    getSessionId: () => id,
    getCwd: () => cwd,
    getLeafId: () => null,
  });
  const SessionManager = {
    create: vi.fn((cwd: string) => manager("new-pi-session", cwd)),
    open: vi.fn((path: string, _sessionDir?: string, cwdOverride?: string) =>
      manager("resume-pi-session", cwdOverride ?? "", path),
    ),
    listAll: vi.fn(async () => [] as Array<{ id: string; path: string }>),
    list: vi.fn(async () => []),
  };
  const createAgentSession = vi.fn(async ({ sessionManager }: any) => ({
    session: {
      sessionId: sessionManager.getSessionId(),
      sessionManager,
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      getUserMessagesForForking: vi.fn(() => []),
      navigateTree: vi.fn(async () => {}),
    },
  }));
  return {
    createAgentSession,
    SessionManager,
    parseSessionEntries: vi.fn(() => []),
    loadSkillsFromDir: vi.fn(() => ({ skills: [], diagnostics: [] })),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => piMock);

describe("SessionStore", () => {
  let tmpDir: string;
  let sessionModule: typeof import("./session.ts");

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "session-store-"));
    process.env.WORKBENCH_WORKSPACE = tmpDir;
    vi.clearAllMocks();
    piMock.SessionManager.listAll.mockResolvedValue([]);
    sessionModule = await import("./session.ts");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.WORKBENCH_WORKSPACE;
    sessionModule.sessionModes.clear();
  });

  it("uses the Pi session id as ManagedSession.id", async () => {
    const store = new sessionModule.SessionStore();
    const managed = await store.create("project-a", "create");

    expect(managed.id).toBe("new-pi-session");
    expect(store.get("new-pi-session")).toBe(managed);
    expect(sessionModule.sessionModes.get("new-pi-session")).toBe("create");
  });

  it("opens the real Pi session file when resumeSessionId is provided", async () => {
    piMock.SessionManager.listAll.mockResolvedValue([{ id: "resume-pi-session", path: "/tmp/pi-session.json" }]);
    const store = new sessionModule.SessionStore();

    const managed = await store.create("project-b", "work", "resume-pi-session");

    expect(piMock.SessionManager.open).toHaveBeenCalledWith(
      "/tmp/pi-session.json",
      undefined,
      join(tmpDir, "project-b"),
    );
    expect(managed.id).toBe("resume-pi-session");
    expect(sessionModule.sessionModes.get("resume-pi-session")).toBe("work");
  });
});
