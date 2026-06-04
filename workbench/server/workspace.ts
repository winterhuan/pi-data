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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(__dirname, "..", "workspace");
const INDEX = join(WORKSPACE, "index.json");

export interface ProjectEntry {
  id: string;
  name: string;
  type: string;
  lastUpdated: string;
}

async function readIndex(): Promise<ProjectEntry[]> {
  try {
    return JSON.parse(await readFile(INDEX, "utf-8"));
  } catch {
    return [];
  }
}

async function writeIndex(entries: ProjectEntry[]): Promise<void> {
  await mkdir(WORKSPACE, { recursive: true });
  await writeFile(INDEX, JSON.stringify(entries, null, 2));
}

function projectDir(name: string): string {
  // 防目录穿越:只取最后一段、去掉分隔符
  const safe = name.replace(/[/\\]/g, "_").trim() || "未命名项目";
  return join(WORKSPACE, safe);
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
  const safeFile = file.replace(/[/\\]/g, "_");
  return readFile(join(projectDir(project), "artifacts", safeFile), "utf-8");
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
  const index = await readIndex();
  const existing = index.find((e) => e.name === opts.project);
  if (existing) {
    existing.lastUpdated = opts.timestamp;
    existing.type = opts.type;
  } else {
    index.push({ id: opts.project, name: opts.project, type: opts.type, lastUpdated: opts.timestamp });
  }
  await writeIndex(index);

  return { path: artifactPath };
}
