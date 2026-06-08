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

import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  loadSkillsFromDir,
  parseSessionEntries,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createZip, readZip, type ZipEntry } from "./zip.ts";
import { deliverablesForType, type DeliverableStatus } from "./deliverables.ts";
import { analyzeArtifactQuality, type ArtifactQualityIssue } from "./quality.ts";

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
  pinned?: boolean;
  tags?: string[];
}

export interface ProjectBrief {
  goal: string;
  audience: string;
  background: string;
  constraints: string;
  acceptance: string;
  updatedAt?: string;
}

export interface ProjectSkill {
  name: string;
  displayName: string;
  description: string;
  valid: boolean;
}

export interface ProjectSessionEntry {
  id: string;
  label: string;
  createdAt: string;
  lastOpened?: string;
}

export interface ArtifactDetail {
  file: string;
  type: string;
  size: number;
  updatedAt: string;
}

export interface ArtifactVersion {
  id: string;
  file: string;
  size: number;
  createdAt: string;
}

export interface TrashedArtifact {
  file: string;
  trashedFile: string;
  trashedAt: string;
  size: number;
  type?: string;
}

export interface SearchResult {
  type: "project" | "artifact";
  project: string;
  file?: string;
  title: string;
  subtitle: string;
  snippet?: string;
  score: number;
}

export interface ProjectExport {
  filename: string;
  zip: Buffer;
}

export interface ProjectDeliveryPackage extends ProjectExport {
  manifest: {
    project: string;
    generatedAt: string;
    readiness: {
      status: ProjectReadiness["status"];
      score: number;
      summary: string;
    };
    deliveryCheck: DeliveryCheck;
    artifacts: ArtifactDetail[];
  };
}

export interface ProjectImportResult {
  project: ProjectEntry;
  imported: {
    artifacts: number;
    bible: number;
    skills: number;
  };
}

export interface WorkspaceActivity {
  id: string;
  kind: "artifact" | "session";
  project: string;
  title: string;
  subtitle: string;
  timestamp: string;
  file?: string;
  type?: string;
  size?: number;
  sessionId?: string;
}

export interface ProjectOverview extends ProjectEntry {
  artifactCount: number;
  sessionCount: number;
  bibleCount: number;
  skillCount: number;
  latestArtifact: string | null;
  deliverables: {
    done: number;
    total: number;
    percent: number;
    items: DeliverableStatus[];
  };
}

export interface WorkspaceOverview {
  projects: ProjectOverview[];
  recentProjects: ProjectOverview[];
  actions: WorkspaceAction[];
  activity: WorkspaceActivity[];
  totals: {
    projects: number;
    artifacts: number;
    sessions: number;
    bible: number;
    skills: number;
  };
}

export interface ArtifactQualitySummary {
  file: string;
  type: string;
  status: "ready" | "needs-work" | "error";
  score: number;
  words: number;
  lines: number;
  issues: ArtifactQualityIssue[];
}

export interface ProjectNextAction {
  id: string;
  title: string;
  description: string;
  prompt: string;
  tone: "primary" | "warning" | "danger" | "info";
  file: string | null;
}

export interface WorkspaceAction extends ProjectNextAction {
  project: string;
  projectType: string;
  projectStatus: ProjectReadiness["status"];
  score: number;
}

export interface ProjectReadiness {
  project: string;
  type: string;
  status: "empty" | "in-progress" | "needs-work" | "error" | "ready";
  score: number;
  summary: string;
  artifactCount: number;
  readyArtifacts: number;
  needsWorkArtifacts: number;
  errorArtifacts: number;
  deliverables: ProjectOverview["deliverables"];
  quality: ArtifactQualitySummary[];
  actions: ProjectNextAction[];
}

export interface DeliveryCheckItem {
  kind: "missing-deliverable" | "quality" | "empty";
  title: string;
  detail: string;
  prompt: string;
  file: string | null;
  severity: "blocker" | "warning";
}

export interface DeliveryCheck {
  project: string;
  ready: boolean;
  status: ProjectReadiness["status"];
  score: number;
  summary: string;
  blockers: DeliveryCheckItem[];
  warnings: DeliveryCheckItem[];
  checkedAt: string;
}

export interface ProjectHandoff {
  project: string;
  file: string;
  generatedAt: string;
  content: string;
  artifact?: ArtifactDetail;
}

const HANDOFF_FILENAME = "handoff-summary.md";

interface ProjectSessionRecord {
  id: string;
  createdAt: string;
  lastOpened: string;
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
    const raw = await readFile(join(getWorkspace(), "index.json"), "utf-8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (Array.isArray(parsed)) return parsed.map(normalizeProjectEntry);
    if (parsed?.name) return [normalizeProjectEntry(parsed)];
    return [];
  } catch {
    return [];
  }
}

function normalizeProjectEntry(entry: any): ProjectEntry {
  return {
    id: String(entry.id ?? entry.name),
    name: String(entry.name ?? entry.id),
    type: String(entry.type ?? "create"),
    lastUpdated: String(entry.lastUpdated ?? entry.created ?? new Date(0).toISOString()),
    pinned: Boolean(entry.pinned),
    tags: normalizeProjectTags(entry.tags),
  };
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

export function normalizeProjectType(input: string): string {
  const type = String(input ?? "").trim().toLowerCase();
  if (!type) throw new Error("project type is required");
  if (type.length > 64 || type.includes("..") || /[/\\]/.test(type)) {
    throw new Error("invalid project type");
  }
  return type;
}

export function normalizeProjectTags(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : String(input ?? "").split(/[,\n，、]/);
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const tag = String(item ?? "").trim().replace(/^#+/, "").replace(/\s+/g, " ").slice(0, 24).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

function briefField(input: unknown, max = 900): string {
  return String(input ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function normalizeProjectBrief(input: any, updatedAt?: string): ProjectBrief {
  const brief: ProjectBrief = {
    goal: briefField(input?.goal),
    audience: briefField(input?.audience),
    background: briefField(input?.background, 1200),
    constraints: briefField(input?.constraints, 1200),
    acceptance: briefField(input?.acceptance, 1200),
  };
  if (updatedAt || input?.updatedAt) brief.updatedAt = String(updatedAt ?? input.updatedAt);
  return brief;
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

function isWithinWorkspace(path: string): boolean {
  const workspaceRoot = resolve(getWorkspace());
  const resolved = resolve(path);
  const rel = relative(workspaceRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function projectDir(name: string): string {
  const dir = join(getWorkspace(), normalizeProjectName(name));
  if (!isWithinWorkspace(dir)) {
    throw new Error("invalid project name");
  }
  return dir;
}

export async function listProjects(): Promise<ProjectEntry[]> {
  return readIndex();
}

function artifactMatchesDeliverable(artifact: ArtifactDetail, deliverable: Pick<DeliverableStatus, "artifactTypes" | "filenameKeywords">): boolean {
  const typeMatch = Boolean(deliverable.artifactTypes?.includes(artifact.type));
  const lowerName = artifact.file.toLowerCase();
  const keywordMatch = Boolean(deliverable.filenameKeywords?.some((keyword) => lowerName.includes(keyword.toLowerCase())));
  return deliverable.filenameKeywords?.length ? keywordMatch : typeMatch;
}

export async function getProjectDeliverables(project: string): Promise<ProjectOverview["deliverables"]> {
  const entry = (await listProjects()).find((item) => item.name === normalizeProjectName(project));
  const artifacts = await listArtifactDetails(project);
  const items: DeliverableStatus[] = deliverablesForType(entry?.type ?? "create").map((definition) => {
    const match = artifacts.find((artifact) => artifactMatchesDeliverable(artifact, definition));
    return {
      ...definition,
      done: Boolean(match),
      matchedFile: match?.file ?? null,
    };
  });
  const done = items.filter((item) => item.done).length;
  const total = items.length;
  return {
    done,
    total,
    percent: total ? Math.round((done / total) * 100) : 0,
    items,
  };
}

function actionForQuality(project: string, item: ArtifactQualitySummary): ProjectNextAction {
  const issueText = item.issues.length
    ? item.issues.map((issue, index) => `${index + 1}. ${issue.message}`).join("\n")
    : "请整体提升结构、完整度和可交付性。";
  const isError = item.status === "error";
  return {
    id: `${isError ? "fix" : "refine"}-${item.file}`,
    title: `${isError ? "修复" : "打磨"} ${item.file}`,
    description: item.issues[0]?.message ?? "让这份产物更接近可直接交付。",
    prompt: `请${isError ? "修复" : "打磨"}产物 ${item.file}。\n\n需要处理的问题：\n${issueText}\n\n请保留有用信息，补齐结构和细节，修复格式问题，并保存回项目「${project}」的同名产物。`,
    tone: isError ? "danger" : "warning",
    file: item.file,
  };
}

function readinessSummary(status: ProjectReadiness["status"], opts: {
  missing: number;
  needsWork: number;
  errors: number;
  ready: number;
  total: number;
}): string {
  if (status === "empty") return "还没有产物，先生成第一份可交付内容。";
  if (status === "error") return `${opts.errors} 个产物存在格式问题，需要先修复。`;
  if (status === "needs-work") {
    const pieces = [];
    if (opts.missing) pieces.push(`${opts.missing} 个交付项未补齐`);
    if (opts.needsWork) pieces.push(`${opts.needsWork} 个产物需要打磨`);
    return `${pieces.join("，")}，继续推进即可交付。`;
  }
  if (status === "in-progress") return "已有可用产物，继续补齐交付清单。";
  return `${opts.ready}/${opts.total} 个产物已达可交付状态，可以整理交付包。`;
}

async function requireProjectEntry(project: string): Promise<ProjectEntry> {
  const name = normalizeProjectName(project);
  const entry = (await listProjects()).find((item) => item.name === name);
  if (!entry) throw new Error("project not found");
  return entry;
}

function markdownCell(value: unknown): string {
  const text = String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  return text || "-";
}

function readinessStatusLabel(status: ProjectReadiness["status"]): string {
  return ({
    empty: "待启动",
    "in-progress": "推进中",
    "needs-work": "需打磨",
    error: "需修复",
    ready: "可交付",
  })[status] ?? "检查中";
}

function qualityStatusLabel(status: ArtifactQualitySummary["status"]): string {
  return ({
    ready: "可交付",
    "needs-work": "需打磨",
    error: "需修复",
  })[status] ?? "待检查";
}

function formatHandoffDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}

function buildIssueBullets(readiness: ProjectReadiness): string[] {
  const lines: string[] = [];
  const missing = readiness.deliverables.items.filter((item) => !item.done);
  for (const item of missing) {
    lines.push(`- 缺少交付项: ${item.title}。${item.description}`);
  }
  for (const item of readiness.quality) {
    for (const issue of item.issues.filter((candidate) => candidate.level !== "ok")) {
      lines.push(`- ${item.file}: ${issue.message}`);
    }
  }
  if (!lines.length) lines.push("- 当前没有发现阻塞性交付风险，建议人工复核关键事实和对外口径。");
  return lines.slice(0, 10);
}

export async function buildProjectHandoff(
  project: string,
  timestamp = new Date().toISOString(),
): Promise<ProjectHandoff> {
  const entry = await requireProjectEntry(project);
  const [artifacts, sessions, bible, skills, readiness] = await Promise.all([
    listArtifactDetails(entry.name),
    listProjectSessions(entry.name),
    listBible(entry.name),
    listSkills(entry.name),
    getProjectReadiness(entry.name),
  ]);

  const qualityByFile = new Map(readiness.quality.map((item) => [item.file, item]));
  const deliverableRows = readiness.deliverables.items.length
    ? readiness.deliverables.items.map((item) => (
      `| ${markdownCell(item.title)} | ${item.done ? "完成" : "待补齐"} | ${markdownCell(item.matchedFile)} | ${markdownCell(item.description)} |`
    ))
    : ["| - | - | - | 未配置交付清单 |"];
  const artifactRows = artifacts.length
    ? artifacts.map((artifact) => {
      const quality = qualityByFile.get(artifact.file);
      return `| ${markdownCell(artifact.file)} | ${markdownCell(artifact.type)} | ${formatArtifactSize(artifact.size)} | ${formatHandoffDate(artifact.updatedAt)} | ${quality ? `${qualityStatusLabel(quality.status)} ${quality.score}/100` : "未检查"} |`;
    })
    : ["| - | - | - | - | 还没有产物 |"];
  const nextActions = readiness.actions.length
    ? readiness.actions.map((action, index) => `${index + 1}. ${action.title}: ${action.description}`)
    : ["1. 暂无系统建议，建议人工确认是否可以对外交付。"];

  const content = [
    `# ${entry.name} 交接摘要`,
    "",
    `生成时间: ${formatHandoffDate(timestamp)}`,
    `项目类型: ${entry.type}`,
    `当前状态: ${readinessStatusLabel(readiness.status)} (${readiness.score}/100)`,
    `摘要: ${readiness.summary}`,
    "",
    "## 当前结论",
    "",
    `- 产物数量: ${readiness.artifactCount}`,
    `- 交付进度: ${readiness.deliverables.done}/${readiness.deliverables.total} (${readiness.deliverables.percent}%)`,
    `- 可交付产物: ${readiness.readyArtifacts}`,
    `- 需要打磨: ${readiness.needsWorkArtifacts}`,
    `- 需要修复: ${readiness.errorArtifacts}`,
    "",
    "## 交付清单",
    "",
    "| 交付项 | 状态 | 对应产物 | 说明 |",
    "| --- | --- | --- | --- |",
    ...deliverableRows,
    "",
    "## 产物清单",
    "",
    "| 文件 | 类型 | 大小 | 更新时间 | 质量 |",
    "| --- | --- | ---: | --- | --- |",
    ...artifactRows,
    "",
    "## 风险与缺口",
    "",
    ...buildIssueBullets(readiness),
    "",
    "## 建议下一步",
    "",
    ...nextActions,
    "",
    "## 项目素材",
    "",
    `- 会话: ${sessions.length}`,
    `- 创作设定: ${bible.length}`,
    `- 项目技能: ${skills.length}`,
    "",
    "## 使用方式",
    "",
    "- 在工作台右侧预览、复制或下载关键产物。",
    "- 使用项目导出功能打包全部产物、历史版本、设定和技能。",
    "- 如果状态不是可交付，优先处理上方风险与缺口，再重新生成交接摘要。",
    "",
  ].join("\n");

  return {
    project: entry.name,
    file: HANDOFF_FILENAME,
    generatedAt: timestamp,
    content,
  };
}

export async function createProjectHandoff(
  project: string,
  timestamp = new Date().toISOString(),
): Promise<ProjectHandoff> {
  const handoff = await buildProjectHandoff(project, timestamp);
  const artifact = await saveArtifact({
    project: handoff.project,
    type: "markdown",
    filename: handoff.file,
    content: handoff.content,
    timestamp,
  });
  const details = await listArtifactDetails(handoff.project);
  return { ...handoff, artifact: details.find((item) => item.file === handoff.file) ?? {
    file: handoff.file,
    type: artifactType(handoff.file),
    size: Buffer.byteLength(handoff.content),
    updatedAt: timestamp,
  } };
}

export async function getProjectReadiness(project: string): Promise<ProjectReadiness> {
  const name = normalizeProjectName(project);
  const entry = (await listProjects()).find((item) => item.name === name);
  const [artifacts, deliverables] = await Promise.all([
    listArtifactDetails(name),
    getProjectDeliverables(name),
  ]);

  const quality: ArtifactQualitySummary[] = [];
  for (const artifact of artifacts.slice(0, 20)) {
    try {
      const analysis = analyzeArtifactQuality(artifact.file, await readArtifact(name, artifact.file));
      quality.push({
        file: artifact.file,
        type: artifact.type,
        status: analysis.status,
        score: analysis.score,
        words: analysis.words,
        lines: analysis.lines,
        issues: analysis.issues.filter((issue) => issue.level !== "ok").slice(0, 3),
      });
    } catch {
      quality.push({
        file: artifact.file,
        type: artifact.type,
        status: "error",
        score: 0,
        words: 0,
        lines: 0,
        issues: [{ level: "error", message: "产物无法读取，请检查文件。" }],
      });
    }
  }

  quality.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));

  const missingDeliverables = deliverables.items.filter((item) => !item.done);
  const readyArtifacts = quality.filter((item) => item.status === "ready").length;
  const needsWorkArtifacts = quality.filter((item) => item.status === "needs-work").length;
  const errorArtifacts = quality.filter((item) => item.status === "error").length;
  const averageQuality = quality.length
    ? Math.round(quality.reduce((sum, item) => sum + item.score, 0) / quality.length)
    : 0;
  const score = artifacts.length
    ? Math.max(0, Math.min(100, Math.round(deliverables.percent * 0.45 + averageQuality * 0.45 + Math.min(10, artifacts.length * 2))))
    : 0;

  const status: ProjectReadiness["status"] = !artifacts.length
    ? "empty"
    : errorArtifacts > 0
      ? "error"
      : needsWorkArtifacts > 0
        ? "needs-work"
        : missingDeliverables.length > 0
          ? "in-progress"
          : "ready";

  const actions: ProjectNextAction[] = [];
  if (!artifacts.length) {
    const first = missingDeliverables[0] ?? deliverables.items[0];
    actions.push({
      id: "first-artifact",
      title: first ? `生成${first.title}` : "生成第一份产物",
      description: first?.description ?? "先把想法变成一份可保存、可预览的产物。",
      prompt: first?.prompt ?? `请为项目「${name}」生成第一份可交付产物，使用 Markdown，并保存为产物。`,
      tone: "primary",
      file: null,
    });
  }

  for (const item of missingDeliverables.slice(0, 3)) {
    actions.push({
      id: `deliverable-${item.id}`,
      title: `补齐${item.title}`,
      description: item.description,
      prompt: item.prompt,
      tone: "primary",
      file: item.matchedFile,
    });
  }

  const weakArtifact = quality.find((item) => item.status === "error")
    ?? quality.find((item) => item.status === "needs-work");
  if (weakArtifact) actions.push(actionForQuality(name, weakArtifact));

  if (status === "ready") {
    actions.push({
      id: "handoff",
      title: "整理交付包",
      description: "把已完成产物整理成一份对外可读的交付摘要。",
      prompt: `请基于项目「${name}」当前产物整理一份交付摘要：列出已完成材料、核心结论、使用方式、风险和下一步，并保存为 Markdown 产物。`,
      tone: "info",
      file: null,
    });
  }

  return {
    project: name,
    type: entry?.type ?? "create",
    status,
    score,
    summary: readinessSummary(status, {
      missing: missingDeliverables.length,
      needsWork: needsWorkArtifacts,
      errors: errorArtifacts,
      ready: readyArtifacts,
      total: quality.length,
    }),
    artifactCount: artifacts.length,
    readyArtifacts,
    needsWorkArtifacts,
    errorArtifacts,
    deliverables,
    quality,
    actions: actions.slice(0, 4),
  };
}

export async function getDeliveryCheck(
  project: string,
  timestamp = new Date().toISOString(),
): Promise<DeliveryCheck> {
  const readiness = await getProjectReadiness(project);
  const blockers: DeliveryCheckItem[] = [];
  const warnings: DeliveryCheckItem[] = [];

  if (!readiness.artifactCount) {
    blockers.push({
      kind: "empty",
      title: "还没有可交付产物",
      detail: "请先生成至少一份产物，再下载交付包。",
      prompt: readiness.actions.find((action) => action.id === "first-artifact")?.prompt
        ?? `请为项目「${readiness.project}」生成第一份可交付产物，并保存为 Markdown 产物。`,
      file: null,
      severity: "blocker",
    });
  }

  for (const item of readiness.deliverables.items.filter((candidate) => !candidate.done)) {
    blockers.push({
      kind: "missing-deliverable",
      title: `缺少${item.title}`,
      detail: item.description,
      prompt: item.prompt,
      file: null,
      severity: "blocker",
    });
  }

  for (const item of readiness.quality) {
    const detail = item.issues[0]?.message ?? "产物质量需要复核。";
    if (item.status === "error") {
      blockers.push({
        kind: "quality",
        title: `${item.file} 需要修复`,
        detail,
        prompt: actionForQuality(readiness.project, item).prompt,
        file: item.file,
        severity: "blocker",
      });
    } else if (item.status === "needs-work") {
      warnings.push({
        kind: "quality",
        title: `${item.file} 建议打磨`,
        detail,
        prompt: actionForQuality(readiness.project, item).prompt,
        file: item.file,
        severity: "warning",
      });
    }
  }

  return {
    project: readiness.project,
    ready: !blockers.length && readiness.status === "ready",
    status: readiness.status,
    score: readiness.score,
    summary: readiness.summary,
    blockers,
    warnings,
    checkedAt: timestamp,
  };
}

const workspaceStatusRank: Record<ProjectReadiness["status"], number> = {
  error: 0,
  empty: 1,
  "needs-work": 2,
  "in-progress": 3,
  ready: 4,
};

const actionToneRank: Record<ProjectNextAction["tone"], number> = {
  danger: 0,
  primary: 1,
  warning: 2,
  info: 3,
};

function actionLimit(value: number): number {
  if (!Number.isFinite(value)) return 12;
  return Math.max(0, Math.min(50, Math.floor(value)));
}

export async function listWorkspaceActions(limit = 12): Promise<WorkspaceAction[]> {
  const max = actionLimit(limit);
  if (!max) return [];

  const projects = await listProjects();
  const actions: WorkspaceAction[] = [];
  await Promise.all(projects.map(async (entry) => {
    try {
      const readiness = await getProjectReadiness(entry.name);
      for (const action of readiness.actions.slice(0, 3)) {
        actions.push({
          ...action,
          id: `${readiness.project}:${action.id}`,
          project: readiness.project,
          projectType: readiness.type,
          projectStatus: readiness.status,
          score: readiness.score,
        });
      }
    } catch {
      // A broken project should not hide useful actions from the rest of the workspace.
    }
  }));

  actions.sort((a, b) =>
    (workspaceStatusRank[a.projectStatus] ?? 9) - (workspaceStatusRank[b.projectStatus] ?? 9) ||
    a.score - b.score ||
    (actionToneRank[a.tone] ?? 9) - (actionToneRank[b.tone] ?? 9) ||
    a.project.localeCompare(b.project) ||
    a.title.localeCompare(b.title)
  );
  return actions.slice(0, max);
}

export async function listWorkspaceActivity(limit = 16): Promise<WorkspaceActivity[]> {
  const max = actionLimit(limit);
  if (!max) return [];

  const projects = await listProjects();
  const activity: WorkspaceActivity[] = [];
  await Promise.all(projects.map(async (project) => {
    try {
      const [artifacts, sessions] = await Promise.all([
        listArtifactDetails(project.name),
        listProjectSessions(project.name),
      ]);
      for (const artifact of artifacts.slice(0, 4)) {
        activity.push({
          id: `${project.name}:artifact:${artifact.file}`,
          kind: "artifact",
          project: project.name,
          title: artifact.file,
          subtitle: `${artifact.type} · ${formatArtifactSize(artifact.size)}`,
          timestamp: artifact.updatedAt,
          file: artifact.file,
          type: artifact.type,
          size: artifact.size,
        });
      }
      for (const session of sessions.slice(0, 3)) {
        activity.push({
          id: `${project.name}:session:${session.id}`,
          kind: "session",
          project: project.name,
          title: session.label || session.id.slice(0, 12),
          subtitle: "历史会话",
          timestamp: session.lastOpened ?? session.createdAt,
          sessionId: session.id,
        });
      }
    } catch {
      // Keep the dashboard useful even if one project has malformed runtime files.
    }
  }));

  return activity
    .filter((item) => Boolean(item.timestamp))
    .sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp) ||
      a.project.localeCompare(b.project) ||
      a.title.localeCompare(b.title)
    )
    .slice(0, max);
}

export async function listProjectOverviews(): Promise<ProjectOverview[]> {
  const projects = await listProjects();
  const overviews = await Promise.all(projects.map(async (project) => {
    const [artifactDetails, sessions, bible, skills, deliverables] = await Promise.all([
      listArtifactDetails(project.name),
      listProjectSessions(project.name),
      listBible(project.name),
      listSkills(project.name),
      getProjectDeliverables(project.name),
    ]);

    return {
      ...project,
      artifactCount: artifactDetails.length,
      sessionCount: sessions.length,
      bibleCount: bible.length,
      skillCount: skills.length,
      latestArtifact: artifactDetails[0]?.file ?? null,
      deliverables,
    };
  }));

  return overviews.sort((a, b) =>
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    b.lastUpdated.localeCompare(a.lastUpdated)
  );
}

export async function getWorkspaceOverview(): Promise<WorkspaceOverview> {
  const [projects, actions, activity] = await Promise.all([
    listProjectOverviews(),
    listWorkspaceActions(12),
    listWorkspaceActivity(16),
  ]);
  const totals = projects.reduce(
    (acc, project) => {
      acc.artifacts += project.artifactCount;
      acc.sessions += project.sessionCount;
      acc.bible += project.bibleCount;
      acc.skills += project.skillCount;
      return acc;
    },
    { projects: projects.length, artifacts: 0, sessions: 0, bible: 0, skills: 0 },
  );

  return {
    projects,
    recentProjects: projects.slice(0, 6),
    actions,
    activity,
    totals,
  };
}

export async function searchWorkspace(query: string, limit = 30): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: SearchResult[] = [];
  const projects = await listProjects();

  for (const project of projects) {
    const projectName = project.name.toLowerCase();
    const tagHit = (project.tags || []).some((tag) => tag.toLowerCase().includes(q));
    if (projectName.includes(q) || project.type.toLowerCase().includes(q) || tagHit) {
      results.push({
        type: "project",
        project: project.name,
        title: project.name,
        subtitle: [project.type, ...(project.tags || []).map((tag) => `#${tag}`), project.lastUpdated.slice(0, 10)].join(" · "),
        score: projectName === q ? 120 : tagHit ? 90 : 80,
      });
    }

    const artifacts = await listArtifactDetails(project.name);
    for (const artifact of artifacts) {
      const fileName = artifact.file.toLowerCase();
      let score = 0;
      let snippet = "";

      if (fileName.includes(q)) {
        score += fileName === q ? 100 : 65;
      }

      try {
        const content = await readArtifact(project.name, artifact.file);
        const contentHit = content.toLowerCase().indexOf(q);
        if (contentHit >= 0) {
          score += 45;
          snippet = contentSnippet(content, contentHit, query.trim().length);
        }
      } catch {
        // Ignore unreadable artifacts in search results.
      }

      if (score > 0) {
        results.push({
          type: "artifact",
          project: project.name,
          file: artifact.file,
          title: artifact.file,
          subtitle: `${project.name} · ${artifact.type} · ${formatArtifactSize(artifact.size)}`,
          snippet,
          score,
        });
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export async function createDeliveryPackage(
  project: string,
  timestamp = new Date().toISOString(),
): Promise<ProjectDeliveryPackage> {
  const entry = await requireProjectEntry(project);
  const [artifacts, readiness, handoff] = await Promise.all([
    listArtifactDetails(entry.name),
    getProjectReadiness(entry.name),
    buildProjectHandoff(entry.name, timestamp),
  ]);
  const deliveryCheck = await getDeliveryCheck(entry.name, timestamp);
  const manifest: ProjectDeliveryPackage["manifest"] = {
    project: entry.name,
    generatedAt: timestamp,
    readiness: {
      status: readiness.status,
      score: readiness.score,
      summary: readiness.summary,
    },
    deliveryCheck,
    artifacts,
  };
  const entries: ZipEntry[] = [];

  await addTextEntry(entries, "README.md", handoff.content, new Date(timestamp));
  await addTextEntry(entries, "manifest.json", JSON.stringify(manifest, null, 2), new Date(timestamp));

  for (const artifact of artifacts) {
    const filePath = join(projectDir(entry.name), "artifacts", normalizeFileName(artifact.file));
    if (!isWithinWorkspace(filePath)) continue;
    entries.push({
      path: `artifacts/${artifact.file}`,
      data: await readFile(filePath),
      mtime: (await stat(filePath)).mtime,
    });
  }

  return {
    filename: `${entry.name}-delivery.zip`,
    zip: createZip(entries),
    manifest,
  };
}

export async function exportProject(project: string): Promise<ProjectExport> {
  const name = normalizeProjectName(project);
  const dir = projectDir(name);
  const entries: ZipEntry[] = [];
  const manifest = {
    project: name,
    exportedAt: new Date().toISOString(),
    artifacts: await listArtifactDetails(name),
    bible: await listBible(name),
    skills: (await listSkills(name)).map((skill) => ({
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      valid: skill.valid,
    })),
  };

  await addTextEntry(entries, "manifest.json", JSON.stringify(manifest, null, 2));

  try {
    entries.push({
      path: "meta.json",
      data: await readFile(join(dir, "meta.json")),
      mtime: (await stat(join(dir, "meta.json"))).mtime,
    });
  } catch {
    // meta.json is best effort for very old projects.
  }

  for (const artifact of manifest.artifacts) {
    const filePath = join(dir, "artifacts", normalizeFileName(artifact.file));
    if (!isWithinWorkspace(filePath)) continue;
    entries.push({
      path: `artifacts/${artifact.file}`,
      data: await readFile(filePath),
      mtime: (await stat(filePath)).mtime,
    });
  }

  for (const artifact of manifest.artifacts) {
    const historyDir = artifactHistoryDir(name, artifact.file);
    const versions = await listArtifactVersions(name, artifact.file);
    for (const version of versions) {
      const versionPath = join(historyDir, version.id);
      if (!isWithinWorkspace(versionPath)) continue;
      entries.push({
        path: `history/${artifact.file}/${version.id}`,
        data: await readFile(versionPath),
        mtime: (await stat(versionPath)).mtime,
      });
    }
  }

  for (const bible of manifest.bible) {
    await addTextEntry(entries, `bible/${bible.kind}/${bible.name}.md`, bible.content);
  }

  const skillsDir = join(dir, ".pi", "skills");
  for (const skill of manifest.skills) {
    const skillPath = join(skillsDir, normalizeFileName(skill.name), "SKILL.md");
    if (!isWithinWorkspace(skillPath)) continue;
    try {
      entries.push({
        path: `skills/${skill.name}/SKILL.md`,
        data: await readFile(skillPath),
        mtime: (await stat(skillPath)).mtime,
      });
    } catch {
      // Skill diagnostics already tolerate malformed or missing skill files.
    }
  }

  return {
    filename: `${name}.zip`,
    zip: createZip(entries),
  };
}

export async function importProjectZip(zip: Buffer, preferredName?: string): Promise<ProjectImportResult> {
  const entries = readZip(zip);
  const byPath = new Map(entries.map((entry) => [entry.path.replace(/\\/g, "/"), entry.data]));
  const manifestRaw = byPath.get("manifest.json");
  if (!manifestRaw) throw new Error("manifest.json is required");
  const manifest = JSON.parse(manifestRaw.toString("utf-8").replace(/^\uFEFF/, ""));
  const projectName = await uniqueImportedProjectName(preferredName || manifest.project || "imported-project");
  const dir = projectDir(projectName);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });

  let artifactCount = 0;
  let bibleCount = 0;
  let skillCount = 0;

  for (const entry of entries) {
    const safePath = entry.path.replace(/\\/g, "/");
    if (safePath === "manifest.json") continue;
    if (safePath === "meta.json") {
      const meta = safeJson(entry.data.toString("utf-8")) ?? {};
      meta.name = projectName;
      meta.lastUpdated = new Date().toISOString();
      await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
      continue;
    }
    if (safePath.startsWith("artifacts/")) {
      const file = normalizeFileName(safePath.slice("artifacts/".length));
      await writeFile(join(dir, "artifacts", file), entry.data);
      artifactCount++;
      continue;
    }
    if (safePath.startsWith("history/")) {
      const rest = safePath.slice("history/".length);
      const slash = rest.lastIndexOf("/");
      if (slash <= 0) continue;
      const file = normalizeFileName(rest.slice(0, slash));
      const version = normalizeVersionId(rest.slice(slash + 1));
      const historyDir = artifactHistoryDir(projectName, file);
      await mkdir(historyDir, { recursive: true });
      await writeFile(join(historyDir, version), entry.data);
      continue;
    }
    if (safePath.startsWith("bible/")) {
      const parts = safePath.split("/");
      if (parts.length !== 3) continue;
      const kind = normalizeFileName(parts[1]);
      const file = normalizeFileName(parts[2]);
      await mkdir(join(dir, "bible", kind), { recursive: true });
      await writeFile(join(dir, "bible", kind, file), entry.data);
      bibleCount++;
      continue;
    }
    if (safePath.startsWith("skills/")) {
      const parts = safePath.split("/");
      if (parts.length !== 3 || parts[2] !== "SKILL.md") continue;
      const skillName = normalizeFileName(parts[1]);
      await mkdir(join(dir, ".pi", "skills", skillName), { recursive: true });
      await writeFile(join(dir, ".pi", "skills", skillName, "SKILL.md"), entry.data);
      skillCount++;
    }
  }

  const now = new Date().toISOString();
  const metaPath = join(dir, "meta.json");
  let meta = safeJson((await readFile(metaPath, "utf-8").catch(() => "{}"))) ?? {};
  meta.name = projectName;
  meta.type = meta.type || manifest.type || "imported";
  meta.created = meta.created || now;
  meta.lastUpdated = now;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  const projectEntry: ProjectEntry = { id: projectName, name: projectName, type: meta.type, lastUpdated: now, tags: normalizeProjectTags(meta.tags) };
  await withIndexLock(async () => {
    const index = (await readIndex()).filter((entry) => entry.name !== projectName);
    index.push(projectEntry);
    await writeIndex(index);
  });

  return {
    project: projectEntry,
    imported: { artifacts: artifactCount, bible: bibleCount, skills: skillCount },
  };
}

export async function renameProject(opts: {
  from: string;
  to: string;
  timestamp: string;
}): Promise<ProjectEntry> {
  const from = normalizeProjectName(opts.from);
  const to = normalizeProjectName(opts.to);
  if (from === to) {
    const existing = (await readIndex()).find((entry) => entry.name === from);
    if (existing) return existing;
    throw new Error("project not found");
  }

  const fromDir = projectDir(from);
  const toDir = projectDir(to);
  const source = await stat(fromDir).catch(() => null);
  if (!source?.isDirectory()) throw new Error("project not found");
  const target = await stat(toDir).catch(() => null);
  if (target) throw new Error("project already exists");

  await rename(fromDir, toDir);

  const metaPath = join(toDir, "meta.json");
  let meta = safeJson((await readFile(metaPath, "utf-8").catch(() => "{}"))) ?? {};
  meta.name = to;
  meta.type = meta.type || "create";
  meta.created = meta.created || opts.timestamp;
  meta.lastUpdated = opts.timestamp;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  const entry: ProjectEntry = {
    id: to,
    name: to,
    type: meta.type,
    lastUpdated: opts.timestamp,
    pinned: Boolean(meta.pinned),
    tags: normalizeProjectTags(meta.tags),
  };

  await withIndexLock(async () => {
    const index = (await readIndex()).filter((item) => item.name !== from && item.name !== to);
    index.push(entry);
    await writeIndex(index);
  });

  return entry;
}

export async function setProjectPinned(opts: {
  project: string;
  pinned: boolean;
  timestamp: string;
}): Promise<ProjectEntry> {
  const project = normalizeProjectName(opts.project);
  const dir = projectDir(project);
  const source = await stat(dir).catch(() => null);
  if (!source?.isDirectory()) throw new Error("project not found");

  const metaPath = join(dir, "meta.json");
  let meta = safeJson((await readFile(metaPath, "utf-8").catch(() => "{}"))) ?? {};
  meta.name = project;
  meta.type = meta.type || "create";
  meta.pinned = Boolean(opts.pinned);
  meta.tags = normalizeProjectTags(meta.tags);
  meta.lastUpdated = meta.lastUpdated || opts.timestamp;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  let entry: ProjectEntry | undefined;
  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((item) => item.name === project);
    if (existing) {
      existing.pinned = Boolean(opts.pinned);
      existing.type = existing.type || meta.type || "create";
      existing.tags = normalizeProjectTags(existing.tags?.length ? existing.tags : meta.tags);
      entry = existing;
    } else {
      entry = {
        id: project,
        name: project,
        type: meta.type || "create",
        lastUpdated: meta.lastUpdated || opts.timestamp,
        pinned: Boolean(opts.pinned),
        tags: normalizeProjectTags(meta.tags),
      };
      index.push(entry);
    }
    await writeIndex(index);
  });

  return entry!;
}

export async function setProjectType(opts: {
  project: string;
  type: string;
  timestamp: string;
}): Promise<ProjectEntry> {
  const project = normalizeProjectName(opts.project);
  const type = normalizeProjectType(opts.type);
  const dir = projectDir(project);
  const source = await stat(dir).catch(() => null);
  if (!source?.isDirectory()) throw new Error("project not found");

  const metaPath = join(dir, "meta.json");
  let meta = safeJson((await readFile(metaPath, "utf-8").catch(() => "{}"))) ?? {};

  let entry: ProjectEntry | undefined;
  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((item) => item.name === project);
    const pinned = existing ? Boolean(existing.pinned) : Boolean(meta.pinned);
    const tags = normalizeProjectTags(existing?.tags?.length ? existing.tags : meta.tags);
    meta.name = project;
    meta.type = type;
    meta.created = meta.created || opts.timestamp;
    meta.lastUpdated = opts.timestamp;
    meta.pinned = pinned;
    meta.tags = tags;
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    if (existing) {
      existing.type = type;
      existing.lastUpdated = opts.timestamp;
      existing.pinned = pinned;
      existing.tags = tags;
      entry = existing;
    } else {
      entry = {
        id: project,
        name: project,
        type,
        lastUpdated: opts.timestamp,
        pinned,
        tags,
      };
      index.push(entry);
    }
    await writeIndex(index);
  });

  return entry!;
}

export async function setProjectTags(opts: {
  project: string;
  tags: unknown;
  timestamp: string;
}): Promise<ProjectEntry> {
  const project = normalizeProjectName(opts.project);
  const tags = normalizeProjectTags(opts.tags);
  const dir = projectDir(project);
  const source = await stat(dir).catch(() => null);
  if (!source?.isDirectory()) throw new Error("project not found");

  const metaPath = join(dir, "meta.json");
  let meta = safeJson((await readFile(metaPath, "utf-8").catch(() => "{}"))) ?? {};
  meta.name = project;
  meta.type = meta.type || "create";
  meta.tags = tags;
  meta.lastUpdated = meta.lastUpdated || opts.timestamp;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  let entry: ProjectEntry | undefined;
  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((item) => item.name === project);
    if (existing) {
      existing.type = existing.type || meta.type || "create";
      existing.pinned = Boolean(existing.pinned || meta.pinned);
      existing.tags = tags;
      entry = existing;
    } else {
      entry = {
        id: project,
        name: project,
        type: meta.type || "create",
        lastUpdated: meta.lastUpdated || opts.timestamp,
        pinned: Boolean(meta.pinned),
        tags,
      };
      index.push(entry);
    }
    await writeIndex(index);
  });

  return entry!;
}

export async function getProjectBrief(project: string): Promise<ProjectBrief> {
  const name = normalizeProjectName(project);
  const dir = projectDir(name);
  const source = await stat(dir).catch(() => null);
  if (!source?.isDirectory()) throw new Error("project not found");

  const meta = safeJson((await readFile(join(dir, "meta.json"), "utf-8").catch(() => "{}"))) ?? {};
  return normalizeProjectBrief(meta.brief ?? {});
}

export async function setProjectBrief(opts: {
  project: string;
  brief: Partial<ProjectBrief>;
  timestamp: string;
}): Promise<ProjectBrief> {
  const project = normalizeProjectName(opts.project);
  const dir = projectDir(project);
  const source = await stat(dir).catch(() => null);
  if (!source?.isDirectory()) throw new Error("project not found");

  const metaPath = join(dir, "meta.json");
  const meta = safeJson((await readFile(metaPath, "utf-8").catch(() => "{}"))) ?? {};
  const brief = normalizeProjectBrief(opts.brief, opts.timestamp);
  meta.name = project;
  meta.type = meta.type || "create";
  meta.tags = normalizeProjectTags(meta.tags);
  meta.brief = brief;
  meta.lastUpdated = opts.timestamp;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((item) => item.name === project);
    if (existing) {
      existing.lastUpdated = opts.timestamp;
      existing.type = existing.type || meta.type || "create";
      existing.pinned = Boolean(existing.pinned || meta.pinned);
      existing.tags = normalizeProjectTags(existing.tags?.length ? existing.tags : meta.tags);
    } else {
      index.push({
        id: project,
        name: project,
        type: meta.type || "create",
        lastUpdated: opts.timestamp,
        pinned: Boolean(meta.pinned),
        tags: normalizeProjectTags(meta.tags),
      });
    }
    await writeIndex(index);
  });

  return brief;
}

function safeJson(text: string): any | null {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function uniqueImportedProjectName(input: string): Promise<string> {
  const base = normalizeProjectName(input);
  const used = new Set((await readIndex()).map((entry) => entry.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

async function addTextEntry(entries: ZipEntry[], path: string, text: string, mtime = new Date()): Promise<void> {
  entries.push({ path, data: Buffer.from(text, "utf-8"), mtime });
}

function contentSnippet(content: string, index: number, length: number): string {
  const start = Math.max(0, index - 48);
  const end = Math.min(content.length, index + Math.max(length, 1) + 72);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function formatArtifactSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export async function listArtifacts(project: string): Promise<string[]> {
  try {
    return await readdir(join(projectDir(project), "artifacts"));
  } catch {
    return [];
  }
}

export async function listArtifactDetails(project: string): Promise<ArtifactDetail[]> {
  const files = await listArtifacts(project);
  const dir = join(projectDir(project), "artifacts");
  const details: ArtifactDetail[] = [];

  for (const file of files) {
    try {
      const safeFile = normalizeFileName(file);
      const filePath = join(dir, safeFile);
      if (!isWithinWorkspace(filePath)) continue;
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      details.push({
        file,
        type: artifactType(file),
        size: info.size,
        updatedAt: info.mtime.toISOString(),
      });
    } catch {
      // Skip files that disappeared or fail validation during listing.
    }
  }

  return details.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function artifactType(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".fountain")) return "screenplay";
  if (lower.endsWith(".json")) return "json";
  return "text";
}

export async function readArtifact(project: string, file: string): Promise<string> {
  const safeFile = normalizeFileName(file);
  const filePath = join(projectDir(project), "artifacts", safeFile);
  // Enforce root-prefix for file too
  if (!isWithinWorkspace(filePath)) throw new Error("invalid file path");
  return readFile(filePath, "utf-8");
}

function artifactHistoryDir(project: string, file: string): string {
  const safeFile = normalizeFileName(file);
  const dir = join(projectDir(project), "history", encodeURIComponent(safeFile));
  if (!isWithinWorkspace(dir)) throw new Error("invalid history path");
  return dir;
}

function normalizeVersionId(input: string): string {
  const id = input.trim();
  if (!/^[0-9T.Z-]+-[0-9a-f]{6}\.[a-z0-9]+$/i.test(id)) {
    throw new Error("invalid version id");
  }
  return id;
}

function historyVersionId(file: string, timestamp: string, content: string): string {
  const stamp = timestamp.replace(/[^0-9TZ.]/g, "-");
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 6);
  const ext = extname(file).toLowerCase().replace(/[^a-z0-9.]/g, "") || ".txt";
  return `${stamp}-${hash}${ext}`;
}

function trashVersionId(file: string, timestamp: string, content: string): string {
  const stamp = timestamp.replace(/[^0-9TZ.]/g, "-");
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 6);
  const ext = extname(file).toLowerCase().replace(/[^a-z0-9.]/g, "") || ".txt";
  const base = file.slice(0, Math.max(0, file.length - ext.length)).replace(/[^a-z0-9._-]+/gi, "-") || "artifact";
  return `${base}.${stamp}-${hash}${ext}`;
}

function normalizeTrashFileName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("trash filename is required");
  if (name.includes("..") || /[/\\]/.test(name) || name.endsWith(".json")) {
    throw new Error("invalid trash filename");
  }
  return name;
}

async function snapshotArtifact(project: string, file: string, timestamp: string): Promise<void> {
  const filename = normalizeFileName(file);
  const artifactPath = join(projectDir(project), "artifacts", filename);
  if (!isWithinWorkspace(artifactPath)) throw new Error("invalid file path");
  const info = await stat(artifactPath).catch(() => null);
  if (!info?.isFile()) return;
  const content = await readFile(artifactPath, "utf-8");
  const historyDir = artifactHistoryDir(project, filename);
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, historyVersionId(filename, timestamp, content)), content);
}

export async function listArtifactVersions(project: string, file: string): Promise<ArtifactVersion[]> {
  const filename = normalizeFileName(file);
  const dir = artifactHistoryDir(project, filename);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const versions: ArtifactVersion[] = [];
  for (const id of files) {
    try {
      const safeId = normalizeVersionId(id);
      const filePath = join(dir, safeId);
      if (!isWithinWorkspace(filePath)) continue;
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      versions.push({
        id: safeId,
        file: filename,
        size: info.size,
        createdAt: info.mtime.toISOString(),
      });
    } catch {
      // Ignore stale or manually-created files that are not valid versions.
    }
  }

  return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readArtifactVersion(project: string, file: string, versionId: string): Promise<string> {
  const filename = normalizeFileName(file);
  const id = normalizeVersionId(versionId);
  const filePath = join(artifactHistoryDir(project, filename), id);
  if (!isWithinWorkspace(filePath)) throw new Error("invalid history path");
  return readFile(filePath, "utf-8");
}

async function touchProject(project: string, type: string, timestamp: string): Promise<void> {
  const dir = projectDir(project);
  const metaPath = join(dir, "meta.json");
  let meta: any = {};
  try {
    meta = JSON.parse(await readFile(metaPath, "utf-8"));
  } catch {
    meta = { name: project, type, created: timestamp };
  }
  meta.name = project;
  meta.lastUpdated = timestamp;
  meta.type = meta.type || type;
  meta.tags = normalizeProjectTags(meta.tags);
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((e) => e.name === project);
    if (existing) {
      existing.lastUpdated = timestamp;
      existing.type = existing.type || meta.type || type;
      existing.tags = normalizeProjectTags(existing.tags?.length ? existing.tags : meta.tags);
    } else {
      index.push({ id: project, name: project, type: meta.type || type, lastUpdated: timestamp, tags: normalizeProjectTags(meta.tags) });
    }
    await writeIndex(index);
  });
}

export async function updateArtifact(opts: {
  project: string;
  filename: string;
  content: string;
  timestamp: string;
}): Promise<ArtifactDetail> {
  const project = normalizeProjectName(opts.project);
  const filename = normalizeFileName(opts.filename);
  const artifactPath = join(projectDir(project), "artifacts", filename);
  if (!isWithinWorkspace(artifactPath)) throw new Error("invalid file path");

  const before = await stat(artifactPath);
  if (!before.isFile()) throw new Error("artifact not found");

  await snapshotArtifact(project, filename, opts.timestamp);
  await writeFile(artifactPath, opts.content);
  await touchProject(project, artifactType(filename), opts.timestamp);

  const info = await stat(artifactPath);
  return {
    file: filename,
    type: artifactType(filename),
    size: info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

export async function createArtifact(opts: {
  project: string;
  filename: string;
  content: string;
  type?: string;
  timestamp: string;
}): Promise<ArtifactDetail> {
  const project = normalizeProjectName(opts.project);
  const filename = normalizeFileName(opts.filename);
  const dir = projectDir(project);
  const artifactPath = join(dir, "artifacts", filename);
  if (!isWithinWorkspace(artifactPath)) throw new Error("invalid file path");

  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });

  const existing = await stat(artifactPath).catch(() => null);
  if (existing) throw new Error("artifact already exists");

  await writeFile(artifactPath, opts.content);
  await touchProject(project, opts.type || artifactType(filename), opts.timestamp);

  const info = await stat(artifactPath);
  return {
    file: filename,
    type: artifactType(filename),
    size: info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

export async function trashArtifact(opts: {
  project: string;
  filename: string;
  timestamp: string;
}): Promise<TrashedArtifact> {
  const project = normalizeProjectName(opts.project);
  const filename = normalizeFileName(opts.filename);
  const artifactPath = join(projectDir(project), "artifacts", filename);
  if (!isWithinWorkspace(artifactPath)) throw new Error("invalid file path");

  const info = await stat(artifactPath);
  if (!info.isFile()) throw new Error("artifact not found");

  const content = await readFile(artifactPath, "utf-8");
  await snapshotArtifact(project, filename, opts.timestamp);

  const trashDir = join(projectDir(project), "trash", "artifacts");
  if (!isWithinWorkspace(trashDir)) throw new Error("invalid trash path");
  await mkdir(trashDir, { recursive: true });
  const trashedFile = trashVersionId(filename, opts.timestamp, content);
  const trashedPath = join(trashDir, trashedFile);
  if (!isWithinWorkspace(trashedPath)) throw new Error("invalid trash path");
  await rename(artifactPath, trashedPath);
  await writeFile(`${trashedPath}.json`, JSON.stringify({
    originalFile: filename,
    trashedFile,
    trashedAt: opts.timestamp,
    size: info.size,
  }, null, 2));
  await touchProject(project, artifactType(filename), opts.timestamp);

  return {
    file: filename,
    trashedFile,
    trashedAt: opts.timestamp,
    size: info.size,
    type: artifactType(filename),
  };
}

function artifactTrashDir(project: string): string {
  const dir = join(projectDir(project), "trash", "artifacts");
  if (!isWithinWorkspace(dir)) throw new Error("invalid trash path");
  return dir;
}

async function readTrashMeta(project: string, trashedFile: string): Promise<TrashedArtifact> {
  const safeFile = normalizeTrashFileName(trashedFile);
  const dir = artifactTrashDir(project);
  const filePath = join(dir, safeFile);
  const metaPath = `${filePath}.json`;
  if (!isWithinWorkspace(filePath) || !isWithinWorkspace(metaPath)) throw new Error("invalid trash path");
  const [info, metaRaw] = await Promise.all([
    stat(filePath),
    readFile(metaPath, "utf-8").catch(() => "{}"),
  ]);
  if (!info.isFile()) throw new Error("trashed artifact not found");
  const meta = safeJson(metaRaw) ?? {};
  const originalFile = normalizeFileName(String(meta.originalFile || safeFile));
  return {
    file: originalFile,
    trashedFile: safeFile,
    trashedAt: String(meta.trashedAt || info.mtime.toISOString()),
    size: Number(meta.size || info.size),
    type: artifactType(originalFile),
  };
}

export async function listTrashedArtifacts(project: string): Promise<TrashedArtifact[]> {
  const name = normalizeProjectName(project);
  const dir = artifactTrashDir(name);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const items: TrashedArtifact[] = [];
  for (const file of files.filter((item) => !item.endsWith(".json"))) {
    try {
      items.push(await readTrashMeta(name, file));
    } catch {
      // Ignore manually-created or stale trash files that do not validate.
    }
  }
  return items.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
}

export async function restoreTrashedArtifact(opts: {
  project: string;
  trashedFile: string;
  timestamp: string;
}): Promise<ArtifactDetail> {
  const project = normalizeProjectName(opts.project);
  const trashedFile = normalizeTrashFileName(opts.trashedFile);
  const meta = await readTrashMeta(project, trashedFile);
  const dir = artifactTrashDir(project);
  const sourcePath = join(dir, trashedFile);
  const metaPath = `${sourcePath}.json`;
  const targetFile = normalizeFileName(meta.file);
  const targetPath = join(projectDir(project), "artifacts", targetFile);
  if (!isWithinWorkspace(sourcePath) || !isWithinWorkspace(targetPath)) throw new Error("invalid restore path");

  const existing = await stat(targetPath).catch(() => null);
  if (existing) throw new Error("artifact already exists");

  await mkdir(join(projectDir(project), "artifacts"), { recursive: true });
  await rename(sourcePath, targetPath);
  await rm(metaPath, { force: true });
  await touchProject(project, artifactType(targetFile), opts.timestamp);

  const info = await stat(targetPath);
  return {
    file: targetFile,
    type: artifactType(targetFile),
    size: info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

export async function restoreArtifactVersion(opts: {
  project: string;
  filename: string;
  versionId: string;
  timestamp: string;
}): Promise<ArtifactDetail> {
  const project = normalizeProjectName(opts.project);
  const filename = normalizeFileName(opts.filename);
  const content = await readArtifactVersion(project, filename, opts.versionId);
  return updateArtifact({
    project,
    filename,
    content,
    timestamp: opts.timestamp,
  });
}

function sessionRecordPath(project: string, sessionId: string): string {
  return join(projectDir(project), "sessions", `${encodeURIComponent(sessionId)}.json`);
}

export async function recordProjectSession(
  project: string,
  sessionId: string,
  timestamp = new Date().toISOString(),
): Promise<void> {
  const id = sessionId.trim();
  if (!id) throw new Error("session id is required");
  const dir = join(projectDir(project), "sessions");
  await mkdir(dir, { recursive: true });

  let record: ProjectSessionRecord = { id, createdAt: timestamp, lastOpened: timestamp };
  try {
    record = JSON.parse(await readFile(sessionRecordPath(project, id), "utf-8"));
  } catch {
    // New project/session association.
  }
  record.id = id;
  record.lastOpened = timestamp;
  record.createdAt = record.createdAt ?? timestamp;
  await writeFile(sessionRecordPath(project, id), JSON.stringify(record, null, 2));
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
  await snapshotArtifact(project, filename, opts.timestamp);
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
  meta.type = meta.type || opts.type;
  meta.tags = normalizeProjectTags(meta.tags);
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  // 更新 index.json(按 name 去重)
  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((e) => e.name === project);
    if (existing) {
      existing.lastUpdated = opts.timestamp;
      existing.type = existing.type || meta.type || opts.type;
      existing.tags = normalizeProjectTags(existing.tags?.length ? existing.tags : meta.tags);
    } else {
      index.push({ id: project, name: project, type: meta.type || opts.type, lastUpdated: opts.timestamp, tags: normalizeProjectTags(meta.tags) });
    }
    await writeIndex(index);
  });

  return { path: artifactPath };
}

async function readProjectSessionRecords(project: string): Promise<ProjectSessionRecord[]> {
  const dir = join(projectDir(project), "sessions");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const records: ProjectSessionRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const record = JSON.parse(await readFile(join(dir, file), "utf-8"));
      if (record?.id) records.push(record);
    } catch {
      // Skip malformed runtime records.
    }
  }
  return records;
}

function sessionLabel(info: any, fallbackId: string): string {
  return info?.name ?? info?.firstMessage?.slice(0, 40) ?? fallbackId.slice(0, 12);
}

export async function listProjectSessions(project: string): Promise<ProjectSessionEntry[]> {
  try {
    const records = await readProjectSessionRecords(project);
    if (records.length) {
      let all: any[] = [];
      try {
        all = await SessionManager.listAll();
      } catch {
        // Session records still give us enough to show stable project history.
      }
      const byId = new Map(all.map((s) => [s.id, s]));
      return records
        .sort((a, b) => (b.lastOpened ?? b.createdAt).localeCompare(a.lastOpened ?? a.createdAt))
        .slice(0, 20)
        .map((record) => {
          const info = byId.get(record.id);
          return {
            id: record.id,
            label: sessionLabel(info, record.id),
            createdAt: info?.created?.toISOString?.() ?? record.createdAt,
            lastOpened: record.lastOpened ?? record.createdAt,
          };
        });
    }

    // New sessions are recorded above. This cwd lookup keeps older project-bound
    // sessions discoverable without showing unrelated global history.
    const sessions = await SessionManager.list(projectDir(project));
    return sessions
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, 20)
      .map(s => ({
        id: s.id,
        label: sessionLabel(s, s.id),
        createdAt: s.created.toISOString(),
        lastOpened: s.modified.toISOString(),
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
  meta.tags = normalizeProjectTags(meta.tags);
  meta.lastUpdated = meta.lastUpdated ?? now;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  const entry = { id: project, name: project, type: meta.type, lastUpdated: meta.lastUpdated, pinned: Boolean(meta.pinned), tags: normalizeProjectTags(meta.tags) };

  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((e) => e.name === project);
    if (!existing) {
      index.push(entry);
    } else {
      existing.type = meta.type;
      existing.lastUpdated = meta.lastUpdated;
      existing.tags = entry.tags;
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
