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

import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  loadSkillsFromDir,
  parseSessionEntries,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKSPACE = join(__dirname, "..", "workspace");
// 读取时优先使用环境变量(测试/Docker 可覆盖)
export function getWorkspace(): string {
  return process.env.WORKBENCH_WORKSPACE ?? DEFAULT_WORKSPACE;
}

export interface ProjectEntry {
  id: string;
  name: string;
  type: string;
  lastUpdated: string;
}

export interface ProjectSkill {
  name: string;
  displayName: string;
  description: string;
  valid: boolean;
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

export function normalizeProjectName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("project name is required");
  if (name.includes("..") || /[/\\]/.test(name)) {
    throw new Error("invalid project name");
  }
  return name;
}

export function normalizeFileName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("filename is required");
  if (name.includes("..") || /[/\\]/.test(name)) {
    throw new Error("invalid filename");
  }
  return name;
}

export function isValidSkillName(name: string): boolean {
  return (
    /^[a-z0-9-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.endsWith("-") &&
    !name.includes("--") &&
    name.length <= 64
  );
}

export function projectDir(name: string): string {
  const dir = join(getWorkspace(), normalizeProjectName(name));
  const workspaceRoot = resolve(getWorkspace());
  const resolved = resolve(dir);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + "/")) {
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
  const safeFile = normalizeFileName(file);
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
  const project = normalizeProjectName(opts.project);
  const filename = normalizeFileName(opts.filename);
  const dir = projectDir(opts.project);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });

  const artifactPath = join(dir, "artifacts", filename);
  await writeFile(artifactPath, opts.content);

  // 更新 meta.json
  const metaPath = join(dir, "meta.json");
  let meta: any = {};
  try {
    meta = JSON.parse(await readFile(metaPath, "utf-8"));
  } catch {
    meta = { name: project, type: opts.type, created: opts.timestamp };
  }
  meta.name = project;
  meta.lastUpdated = opts.timestamp;
  meta.type = opts.type;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  // 更新 index.json(按 name 去重)
  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((e) => e.name === project);
    if (existing) {
      existing.lastUpdated = opts.timestamp;
      existing.type = opts.type;
    } else {
      index.push({ id: project, name: project, type: opts.type, lastUpdated: opts.timestamp });
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
      if (msg?.role !== "user" && msg?.role !== "assistant") continue;
      if (!msg?.content) continue;
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
        : String(msg.content);
      // 跳过 skill 注入内容（<skill ...> 标签）和空文本
      if (!text || text.trimStart().startsWith("<skill ")) continue;
      msgs.push({ role: msg.role, text });
    }
    return msgs;
  } catch { return []; }
}

export async function findSessionPath(sessionId: string): Promise<string | null> {
  const all = await SessionManager.listAll();
  const info = all.find((s) => s.id === sessionId);
  return info?.path ?? null;
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

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*['"]?(.+?)['"]?$`, "m");
  return frontmatter.match(re)?.[1]?.trim();
}

export async function listSkills(project: string): Promise<ProjectSkill[]> {
  const skillsDir = join(projectDir(project), ".pi", "skills");
  let dirs: string[];
  try { dirs = await readdir(skillsDir); } catch { return []; }
  const skills: ProjectSkill[] = [];
  for (const d of dirs.sort()) {
    try {
      const md = await readFile(join(skillsDir, d, "SKILL.md"), "utf-8");
      const m = md.match(/^---\n([\s\S]*?)\n---/);
      if (!m) continue;
      const name = frontmatterValue(m[1], "name") ?? d;
      const displayName = frontmatterValue(m[1], "displayName") ?? name;
      const description = frontmatterValue(m[1], "description") ?? "";
      skills.push({ name, displayName, description, valid: isValidSkillName(name) });
    } catch { /* skip malformed */ }
  }
  return skills;
}

async function readSkillTemplateName(templatePath: string, fallback: string): Promise<string> {
  try {
    const md = await readFile(join(templatePath, "SKILL.md"), "utf-8");
    const m = md.match(/^---\n([\s\S]*?)\n---/);
    const name = m ? frontmatterValue(m[1], "name") : undefined;
    return name && isValidSkillName(name) ? name : fallback;
  } catch {
    return fallback;
  }
}

async function copySkillTemplates(skillsDest: string): Promise<void> {
  const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills-templates");
  let entries: string[];
  try {
    entries = await readdir(templatesDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const src = join(templatesDir, entry);
    const slug = await readSkillTemplateName(src, entry);
    const dest = join(skillsDest, slug);
    try {
      await access(join(dest, "SKILL.md"));
      continue;
    } catch {
      await cp(src, dest, { recursive: true });
    }
  }
}

/**
 * createProject — 新建项目目录并复制预制 skill 模板
 * 新建项目时调用,把 workbench/skills-templates/ 下的全部 skill 目录
 * 复制到 workspace/{project}/.pi/skills/,让 Pi 自动发现并加载。
 */
export async function createProject(name: string, type = "create"): Promise<ProjectEntry> {
  const project = normalizeProjectName(name);
  const dir = projectDir(project);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });
  const now = new Date().toISOString();

  const metaPath = join(dir, "meta.json");
  let meta: any = {};
  try {
    meta = JSON.parse(await readFile(metaPath, "utf-8"));
  } catch {
    meta = { name: project, type, created: now };
  }
  meta.name = project;
  meta.type = type || meta.type || "create";
  meta.lastUpdated = meta.lastUpdated ?? now;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  const entry = { id: project, name: project, type: meta.type, lastUpdated: meta.lastUpdated };

  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((e) => e.name === project);
    if (!existing) {
      index.push(entry);
    } else {
      existing.type = meta.type;
      existing.lastUpdated = meta.lastUpdated;
    }
    await writeIndex(index);
  });

  const skillsDest = join(dir, ".pi", "skills");
  await mkdir(skillsDest, { recursive: true });
  await copySkillTemplates(skillsDest);

  return entry;
}

export async function loadProjectSkillDiagnostics(project: string) {
  const cwd = projectDir(project);
  return loadSkillsFromDir({ dir: join(cwd, ".pi", "skills"), source: "project" }).diagnostics;
}
