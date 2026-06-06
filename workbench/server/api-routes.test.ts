import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleApi } from "./api.ts";

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
});
