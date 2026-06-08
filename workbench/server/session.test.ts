import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const piMock = vi.hoisted(() => {
  const forkFixture: {
    leafId: string | null;
    forkMessages: Array<{ entryId: string; text: string }>;
    tree: any[];
    branch: any[];
    entries: any[];
  } = {
    leafId: null,
    forkMessages: [],
    tree: [],
    branch: [],
    entries: [],
  };
  const manager = (id: string, cwd: string, path?: string) => ({
    id,
    cwd,
    path,
    getSessionId: () => id,
    getCwd: () => cwd,
    getLeafId: () => forkFixture.leafId,
    getTree: () => forkFixture.tree,
    getBranch: () => forkFixture.branch,
    getEntries: () => forkFixture.entries,
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
      getUserMessagesForForking: vi.fn(() => forkFixture.forkMessages),
      navigateTree: vi.fn(async () => {}),
    },
  }));
  return {
    forkFixture,
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
    piMock.forkFixture.leafId = null;
    piMock.forkFixture.forkMessages = [];
    piMock.forkFixture.tree = [];
    piMock.forkFixture.branch = [];
    piMock.forkFixture.entries = [];
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

  it("returns visual fork tree rows with current path and branchable user messages", async () => {
    const u1 = { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "第一条" } };
    const a1 = { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "回答" }] } };
    const u2 = { type: "message", id: "u2", parentId: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "继续" } };
    const a2 = { type: "message", id: "a2", parentId: "u2", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: "当前回答" } };
    const alt = { type: "message", id: "alt", parentId: "a1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: "另一条分支" } };
    piMock.forkFixture.leafId = "a2";
    piMock.forkFixture.forkMessages = [
      { entryId: "u1", text: "第一条" },
      { entryId: "u2", text: "继续" },
      { entryId: "alt", text: "另一条分支" },
    ];
    piMock.forkFixture.entries = [u1, a1, u2, a2, alt];
    piMock.forkFixture.branch = [u1, a1, u2, a2];
    piMock.forkFixture.tree = [{
      entry: u1,
      children: [{
        entry: a1,
        children: [
          { entry: u2, children: [{ entry: a2, children: [] }] },
          { entry: alt, children: [] },
        ],
      }],
    }];

    const store = new sessionModule.SessionStore();
    const managed = await store.create("tree-proj", "create");
    const tree = store.forkPoints(managed.id);

    expect(tree.leafId).toBe("a2");
    expect(tree.currentPathIds).toEqual(["u1", "a1", "u2", "a2"]);
    expect(tree.branchableCount).toBe(3);
    expect(tree.rows.find((row) => row.id === "u2")).toMatchObject({
      branchable: true,
      onCurrentPath: true,
      kind: "user",
    });
    expect(tree.rows.find((row) => row.id === "a2")).toMatchObject({
      current: true,
      kind: "assistant",
    });
    expect(tree.rows.find((row) => row.id === "alt")).toMatchObject({
      branchable: true,
      onCurrentPath: false,
    });
  });

  it("marks the last visible path row current when the leaf entry is hidden", async () => {
    const u1 = { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "第一条" } };
    const info = { type: "session_info", id: "info1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", name: "隐藏内部节点" };
    piMock.forkFixture.leafId = "info1";
    piMock.forkFixture.forkMessages = [{ entryId: "u1", text: "第一条" }];
    piMock.forkFixture.entries = [u1, info];
    piMock.forkFixture.branch = [u1, info];
    piMock.forkFixture.tree = [{ entry: u1, children: [{ entry: info, children: [] }] }];

    const store = new sessionModule.SessionStore();
    const managed = await store.create("hidden-leaf-proj", "create");
    const tree = store.forkPoints(managed.id);

    expect(tree.rows).toEqual([
      expect.objectContaining({ id: "u1", current: true, onCurrentPath: true }),
    ]);
  });
});
