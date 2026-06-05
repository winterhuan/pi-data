/**
 * workspace.ts — 按 project 组织的产物存储
 *
 * 问题: 三个月后回来要能找到攒下的作品。平铺几百个文件没法浏览。
 *
 * 方案: 按 project 组织,而不是按日期。
 *   workspace/
 *     {project}/
 *       artifacts/   产物文件(.md / .fountain / .csv)
 *       sessions/    关联 session id(JSON)
 *       meta.json    {name, type, created, lastUpdated}
 *     index.json     [{id, name, type, lastUpdated}] — 档案室快速加载
 *
 * save_artifact 写文件时调用 saveArtifact() 更新 meta + index。
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { SessionManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = join(__dirname, "..", "workspace");
// 读取时优先使用环境变量(测试/Docker 可覆盖)
function getWorkspace(): string { return process.env.WORKBENCH_WORKSPACE ?? DEFAULT_WORKSPACE; }

export interface ProjectEntry {
  id: string;
  name: string;
  type: string;
  lastUpdated: string;
}

// 保护 index.json 的异步写锁:防止并发 saveArtifact 调用损坏索引
let _indexLock: Promise<void> = Promise.resolve();
async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _indexLock;
  let unlock!: () => void;
  _indexLock = new Promise<void>(r => { unlock = r; });
  await prev;
  try { return await fn(); } finally { unlock(); }
}

async function readIndex(): Promise<ProjectEntry[]> {
  try {
    return JSON.parse(await readFile(join(getWorkspace(), "index.json"), "utf-8"));
  } catch {
    return [];
  }
}

async function writeIndex(entries: ProjectEntry[]): Promise<void> {
  await mkdir(getWorkspace(), { recursive: true });
  await writeFile(join(getWorkspace(), "index.json"), JSON.stringify(entries, null, 2));
}

function safeSeg(s: string): string {
  return s.replace(/\.\./g, "_").replace(/[/\\]/g, "_").trim() || "未命名项目";
}

function projectDir(name: string): string {
  const dir = join(getWorkspace(), safeSeg(name));
  if (!resolve(dir).startsWith(resolve(getWorkspace()) + "/") && resolve(dir) !== resolve(getWorkspace())) {
    throw new Error("invalid project name");
  }
  return dir;
}

export async function listProjects(): Promise<ProjectEntry[]> {
  return readIndex();
}

export async function listArtifacts(project: string): Promise<string[]> {
  try {
    return await readdir(join(projectDir(project), "artifacts"));
  } catch {
    return [];
  }
}

export async function readArtifact(project: string, file: string): Promise<string> {
  const safeFile = safeSeg(file);
  const filePath = join(projectDir(project), "artifacts", safeFile);
  // Enforce root-prefix for file too
  if (!resolve(filePath).startsWith(resolve(getWorkspace()))) throw new Error("invalid file path");
  return readFile(filePath, "utf-8");
}

/**
 * 保存产物 + 更新 meta.json 和 index.json。
 * timestamp 由调用方传入(Pi 扩展 / server),保持可测性。
 */
export async function saveArtifact(opts: {
  project: string;
  type: string;
  filename: string;
  content: string;
  timestamp: string;
}): Promise<{ path: string }> {
  const dir = projectDir(opts.project);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });

  const safeFile = opts.filename.replace(/[/\\]/g, "_");
  const artifactPath = join(dir, "artifacts", safeFile);
  await writeFile(artifactPath, opts.content);

  // 更新 meta.json
  const metaPath = join(dir, "meta.json");
  let meta: any = {};
  try {
    meta = JSON.parse(await readFile(metaPath, "utf-8"));
  } catch {
    meta = { name: opts.project, type: opts.type, created: opts.timestamp };
  }
  meta.lastUpdated = opts.timestamp;
  meta.type = opts.type;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  // 更新 index.json(按 name 去重)
  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((e) => e.name === opts.project);
    if (existing) {
      existing.lastUpdated = opts.timestamp;
      existing.type = opts.type;
    } else {
      index.push({ id: opts.project, name: opts.project, type: opts.type, lastUpdated: opts.timestamp });
    }
    await writeIndex(index);
  });

  return { path: artifactPath };
}

export async function listProjectSessions(project: string): Promise<Array<{id: string, label: string, createdAt: string}>> {
  try {
    // 优先按 cwd 过滤；v1 会话 cwd 为空字符串，过滤不到时回退到全量列表
    let sessions = await SessionManager.list(projectDir(project));
    if (!sessions.length) sessions = await SessionManager.listAll();
    return sessions
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, 20)
      .map(s => ({
        id: s.id,
        label: s.name ?? s.firstMessage?.slice(0, 40) ?? s.id.slice(0, 12),
        createdAt: s.created.toISOString(),
      }));
  } catch { return []; }
}

/** 读取 Pi session 的历史消息，返回 user/assistant 气泡列表 */
export async function readSessionMessages(sessionId: string): Promise<Array<{role: string, text: string}>> {
  try {
    const all = await SessionManager.listAll();
    const info = all.find(s => s.id === sessionId);
    if (!info) return [];
    const raw = await readFile(info.path, "utf-8");
    const entries = parseSessionEntries(raw);
    const msgs: Array<{role: string, text: string}> = [];
    for (const e of entries) {
      if (e.type !== "message") continue;
      const msg = (e as any).message;
      if (!msg?.role || !msg?.content) continue;
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
        : String(msg.content);
      if (text) msgs.push({ role: msg.role, text });
    }
    return msgs;
  } catch { return []; }
}

export async function listBible(project: string): Promise<Array<{kind: string, name: string, content: string}>> {
  const kinds = ["character", "outline", "worldbuilding", "foreshadowing"] as const;
  const entries: Array<{kind: string, name: string, content: string}> = [];
  for (const kind of kinds) {
    const dir = join(projectDir(project), "bible", kind);
    let files: string[];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files.filter(f => f.endsWith(".md"))) {
      try {
        entries.push({ kind, name: f.replace(/\.md$/, ""), content: await readFile(join(dir, f), "utf-8") });
      } catch { /* skip */ }
    }
  }
  return entries;
}

export async function listSkills(project: string): Promise<Array<{name: string, description: string}>> {
  const skillsDir = join(projectDir(project), ".pi", "skills");
  let dirs: string[];
  try { dirs = await readdir(skillsDir); } catch { return []; }
  const skills: Array<{name: string, description: string}> = [];
  for (const d of dirs) {
    try {
      const md = await readFile(join(skillsDir, d, "SKILL.md"), "utf-8");
      const m = md.match(/^---\n([\s\S]*?)\n---/);
      if (!m) continue;
      const nameM = m[1].match(/^name:\s*(.+)$/m);
      const descM = m[1].match(/^description:\s*['"]?(.+?)['"]?$/m);
      if (nameM) skills.push({ name: nameM[1].trim(), description: descM?.[1].trim() ?? "" });
    } catch { /* skip malformed */ }
  }
  return skills;
}

/**
 * createProject — 新建项目目录并复制预制 skill 模板
 * 新建项目时调用,把 workbench/skills-templates/ 下的全部 skill 目录
 * 复制到 workspace/{project}/.pi/skills/,让 Pi 自动发现并加载。
 */
export async function createProject(name: string): Promise<void> {
  const dir = projectDir(name);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });
  const skillsDest = join(dir, ".pi", "skills");
  await mkdir(skillsDest, { recursive: true });
  const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills-templates");
  try {
    const { cp } = await import("node:fs/promises");
    const entries = await readdir(templatesDir);
    for (const entry of entries) {
      await cp(join(templatesDir, entry), join(skillsDest, entry), { recursive: true });
    }
  } catch { /* templates dir may not exist yet */ }
}
