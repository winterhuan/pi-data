import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { attachWebSocket } from "./ws.ts";

describe("websocket contract", () => {
  let server: Server;
  let url: string;
  let store: any;
  let sessions: Map<string, any>;

  beforeEach(async () => {
    sessions = new Map();
    store = {
      create: vi.fn(async (project: string, mode: string, resumeSessionId?: string) => {
        const id = resumeSessionId ?? "new-pi-session";
        const managed = {
          id,
          project,
          mode,
          paused: false,
          session: {
            subscribe: vi.fn(() => () => {}),
            prompt: vi.fn(async () => {}),
          },
        };
        sessions.set(id, managed);
        return managed;
      }),
      get: vi.fn((id: string) => sessions.get(id)),
      onReconnect: vi.fn((id: string) => sessions.get(id)),
      onDisconnect: vi.fn(),
      setMode: vi.fn(),
      forkPoints: vi.fn(() => ({ points: [], leafId: null })),
      fork: vi.fn(async () => {}),
    };
    server = createServer();
    attachWebSocket(server, store);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad test server address");
    url = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function openClient(): Promise<WebSocket> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(ws));
    });
  }

  function nextJson(ws: WebSocket): Promise<any> {
    return new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
  }

  it("creates new sessions with Pi session id and resumed=false", async () => {
    const ws = await openClient();
    ws.send(JSON.stringify({ type: "create", payload: { project: "ws-proj", mode: "create" } }));
    const msg = await nextJson(ws);

    expect(msg).toMatchObject({
      kind: "created",
      sessionId: "new-pi-session",
      project: "ws-proj",
      mode: "create",
      resumed: false,
    });
    ws.close();
  });

  it("passes resumeSessionId through create and reports resumed=true", async () => {
    const ws = await openClient();
    ws.send(JSON.stringify({
      type: "create",
      payload: { project: "ws-proj", mode: "work", resumeSessionId: "pi-old-session" },
    }));
    const msg = await nextJson(ws);

    expect(store.create).toHaveBeenCalledWith("ws-proj", "work", "pi-old-session");
    expect(msg).toMatchObject({
      kind: "created",
      sessionId: "pi-old-session",
      mode: "work",
      resumed: true,
    });
    ws.close();
  });

  it("returns visual fork tree data over fork_points", async () => {
    store.forkPoints.mockReturnValueOnce({
      points: [{ entryId: "u1", text: "hello" }],
      rows: [{
        id: "u1",
        parentId: null,
        depth: 0,
        kind: "user",
        role: "user",
        text: "hello",
        branchable: true,
        current: false,
        onCurrentPath: true,
        childCount: 1,
      }],
      leafId: "a1",
      currentPathIds: ["u1", "a1"],
      totalEntries: 2,
      branchableCount: 1,
    });
    const ws = await openClient();
    ws.send(JSON.stringify({ type: "create", payload: { project: "ws-proj", mode: "create" } }));
    await nextJson(ws);

    ws.send(JSON.stringify({ type: "fork_points" }));
    const msg = await nextJson(ws);

    expect(msg).toMatchObject({
      kind: "fork_points",
      sessionId: "new-pi-session",
      leafId: "a1",
      currentPathIds: ["u1", "a1"],
      branchableCount: 1,
      rows: [{ id: "u1", kind: "user", branchable: true }],
    });
    ws.close();
  });
});
