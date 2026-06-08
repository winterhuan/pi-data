import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AuthStorage,
  ModelRegistry,
  VERSION,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { lanIp } from "./lan.ts";
import { getWorkspace, listProjects, loadProjectSkillDiagnostics } from "./workspace.ts";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export type CheckStatus = "ok" | "warning" | "error" | "info";

export interface DiagnosticCheck {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export interface HealthSummary {
  ok: boolean;
  nodeVersion: string;
  piSdkVersion: string;
  piCliVersion: string | null;
  workspace: string;
  lanIp: string | null;
  extensionPath: string;
  expectedExtensionTarget: string;
  checks: DiagnosticCheck[];
}

const MIN_NODE = "22.0.0";
const MIN_PI = "0.78.0";

export function repoRoot(): string {
  return resolve(__dirname, "..", "..");
}

export function workbenchExtensionSource(): string {
  return join(repoRoot(), "pi-ext", "workbench");
}

export function installedExtensionPath(): string {
  return join(homedir(), ".pi", "agent", "extensions", "workbench");
}

function compareVersions(a: string, b: string): number {
  const aa = a.match(/\d+(?:\.\d+)*/)?.[0]?.split(".").map(Number) ?? [0];
  const bb = b.match(/\d+(?:\.\d+)*/)?.[0]?.split(".").map(Number) ?? [0];
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function parsePiCliVersionOutput(stdout: string, stderr: string): string | null {
  const output = `${stdout}\n${stderr}`;
  return output.match(/\d+(?:\.\d+)*/)?.[0] ?? null;
}

async function piCliVersion(): Promise<string | null> {
  try {
    const command = process.platform === "win32" ? "cmd.exe" : "pi";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "pi --version"] : ["--version"];
    const { stdout, stderr } = await execFileAsync(command, args);
    return parsePiCliVersionOutput(stdout, stderr);
  } catch {
    return null;
  }
}

async function extensionCheck(): Promise<DiagnosticCheck> {
  const extensionPath = installedExtensionPath();
  const expected = workbenchExtensionSource();
  try {
    const st = await lstat(extensionPath);
    if (!st.isSymbolicLink()) {
      return {
        name: "extension",
        status: "error",
        message: `${extensionPath} exists but is not a symlink`,
        fix: `move it aside, then run npm run setup`,
      };
    }
    const target = resolve(dirname(extensionPath), await readlink(extensionPath));
    if (target !== expected) {
      return {
        name: "extension",
        status: "warning",
        message: `extension symlink points to ${target}`,
        fix: `run npm run setup to repoint it to ${expected}`,
      };
    }
    return { name: "extension", status: "ok", message: `installed at ${extensionPath}` };
  } catch {
    return {
      name: "extension",
      status: "error",
      message: `extension symlink is missing at ${extensionPath}`,
      fix: "run npm run setup",
    };
  }
}

async function workspaceCheck(): Promise<DiagnosticCheck> {
  const workspace = getWorkspace();
  const probe = join(workspace, `.doctor-${process.pid}-${Date.now()}`);
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return { name: "workspace", status: "ok", message: `writable: ${workspace}` };
  } catch (err) {
    return {
      name: "workspace",
      status: "error",
      message: `workspace is not writable: ${(err as Error).message}`,
      fix: `check permissions for ${workspace}`,
    };
  }
}

async function depsCheck(): Promise<DiagnosticCheck> {
  try {
    await access(join(__dirname, "node_modules"), constants.R_OK);
    return { name: "dependencies", status: "ok", message: "node_modules is installed" };
  } catch {
    return {
      name: "dependencies",
      status: "error",
      message: "server dependencies are not installed",
      fix: "run npm install in workbench/server",
    };
  }
}

async function authCheck(): Promise<DiagnosticCheck> {
  try {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const available = await modelRegistry.getAvailable();
    if (!available.length) {
      return {
        name: "auth",
        status: "error",
        message: "no available model found",
        fix: "run pi auth or configure ~/.pi/agent/auth.json",
      };
    }
    return { name: "auth", status: "ok", message: `${available.length} model(s) available` };
  } catch (err) {
    return {
      name: "auth",
      status: "error",
      message: `auth/model check failed: ${(err as Error).message}`,
      fix: "run pi auth or check ~/.pi/agent/auth.json",
    };
  }
}

async function portCheck(port: number): Promise<DiagnosticCheck> {
  const net = await import("node:net");
  return new Promise((resolveCheck) => {
    const server = net.createServer();
    server.once("error", (err: any) => {
      if (err?.code === "EADDRINUSE") {
        resolveCheck({
          name: "port",
          status: "error",
          message: `port ${port} is already in use`,
          fix: `stop the existing process or start with PORT=<free-port>`,
        });
      } else {
        resolveCheck({ name: "port", status: "warning", message: err?.message ?? String(err) });
      }
    });
    server.once("listening", () => {
      server.close(() => resolveCheck({ name: "port", status: "ok", message: `port ${port} is available` }));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function skillChecks(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const templateDir = join(repoRoot(), "workbench", "skills-templates");
  const templateDiagnostics = loadSkillsFromDir({ dir: templateDir, source: "path" }).diagnostics;
  if (templateDiagnostics.length) {
    checks.push({
      name: "skills:templates",
      status: "warning",
      message: `${templateDiagnostics.length} template skill diagnostic(s)`,
      fix: templateDiagnostics.map((d) => `${d.path ?? "unknown"}: ${d.message}`).join("; "),
    });
  } else {
    checks.push({ name: "skills:templates", status: "ok", message: "template skill names are valid" });
  }

  const projects = await listProjects();
  let projectWarnings = 0;
  const examples: string[] = [];
  for (const project of projects) {
    const diagnostics = await loadProjectSkillDiagnostics(project.name);
    projectWarnings += diagnostics.length;
    for (const d of diagnostics.slice(0, 2)) {
      examples.push(`${project.name}: ${d.path ?? "unknown"}: ${d.message}`);
    }
  }
  checks.push(
    projectWarnings
      ? {
          name: "skills:projects",
          status: "warning",
          message: `${projectWarnings} project skill diagnostic(s)`,
          fix: examples.join("; "),
        }
      : { name: "skills:projects", status: "ok", message: "project skill names are valid" },
  );
  return checks;
}

export async function ensureWorkbenchExtensionSymlink(): Promise<void> {
  const dest = installedExtensionPath();
  const src = workbenchExtensionSource();
  await mkdir(dirname(dest), { recursive: true });
  try {
    const st = await lstat(dest);
    if (!st.isSymbolicLink()) {
      throw new Error(`${dest} exists and is not a symlink`);
    }
    const current = resolve(dirname(dest), await readlink(dest));
    if (current === src) return;
    await rm(dest);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  await symlink(src, dest, "dir");
}

export async function checkWorkbench(options: { port?: number; skipPort?: boolean } = {}): Promise<HealthSummary> {
  const nodeVersion = process.versions.node;
  const cliVersion = await piCliVersion();
  const checks: DiagnosticCheck[] = [];

  checks.push(
    compareVersions(nodeVersion, MIN_NODE) >= 0
      ? { name: "node", status: "ok", message: `Node ${nodeVersion}` }
      : { name: "node", status: "error", message: `Node ${nodeVersion} < ${MIN_NODE}`, fix: "install Node 22+" },
  );
  checks.push(
    compareVersions(VERSION, MIN_PI) >= 0
      ? { name: "pi-sdk", status: "ok", message: `Pi SDK ${VERSION}` }
      : { name: "pi-sdk", status: "error", message: `Pi SDK ${VERSION} < ${MIN_PI}`, fix: "run npm install" },
  );
  checks.push(
    cliVersion && compareVersions(cliVersion, MIN_PI) >= 0
      ? { name: "pi-cli", status: "ok", message: `pi ${cliVersion}` }
      : {
          name: "pi-cli",
          status: "warning",
          message: cliVersion ? `pi ${cliVersion} < ${MIN_PI}` : "pi CLI not found",
          fix: "install/update Pi CLI if you use it outside this server",
        },
  );
  checks.push(await depsCheck());
  checks.push(await extensionCheck());
  checks.push(await workspaceCheck());
  checks.push(await authCheck());
  const ip = lanIp();
  checks.push(
    ip
      ? { name: "lan", status: "ok", message: `LAN IP ${ip}` }
      : {
          name: "lan",
          status: "warning",
          message: "LAN IP could not be detected",
          fix: "set WORKBENCH_LAN_IP=192.168.x.x",
        },
  );
  checks.push(...(await skillChecks()));
  if (!options.skipPort) {
    checks.push(await portCheck(options.port ?? Number(process.env.PORT ?? 7777)));
  } else {
    checks.push({ name: "port", status: "info", message: "port check skipped in running server" });
  }

  return {
    ok: checks.every((c) => c.status !== "error"),
    nodeVersion,
    piSdkVersion: VERSION,
    piCliVersion: cliVersion,
    workspace: getWorkspace(),
    lanIp: ip,
    extensionPath: installedExtensionPath(),
    expectedExtensionTarget: workbenchExtensionSource(),
    checks,
  };
}
