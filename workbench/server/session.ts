/**
 * session.ts — AgentSession 生命周期管理
 *
 * 问题: 分叉树是核心功能,分叉会产生多个并发 AgentSession。需要按 sessionId
 * 路由消息,并管理生命周期(关闭 tab 暂停、超时销毁、手机无 session 自动创建)。
 *
 * 方案: Map<sessionId, ManagedSession> 持有所有活跃 session。
 *   - WebSocket 断连 → 30s 后标记 paused
 *   - paused 后 2min 仍未重连 → 销毁 session
 *   - 重连 → 清除销毁定时器,恢复
 *   - server 重启 → 所有 session 丢失(by design,Pi SDK 的 SessionManager
 *     已把消息持久化到 ~/.pi/agent/sessions,历史可回溯,但活跃运行态不保留)
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createProject, findSessionPath, normalizeProjectName, projectDir, recordProjectSession } from "./workspace.ts";

// 让 Pi 扩展(workbench/save_artifact)写到与 server 相同的 workspace。
// 扩展通过 process.env.WORKBENCH_WORKSPACE 读取此路径(SDK 同进程,共享 env)。
const __dirname = dirname(fileURLToPath(import.meta.url));
if (!process.env.WORKBENCH_WORKSPACE) {
  process.env.WORKBENCH_WORKSPACE = join(__dirname, "..", "workspace");
}

export type WorkbenchMode = "work" | "create";

// 问题: 单个 global mode 在并发 session 下会互相覆盖。
// 方案: 用挂在 globalThis 上的 Map<sessionId, mode>。
// Pi 扩展从 symlink 路径加载,不可靠地 import server 文件;因此只共享这份进程内状态。
type WorkbenchGlobals = typeof globalThis & {
  __workbenchSessionModes?: Map<string, WorkbenchMode>;
  __workbenchSessionProjects?: Map<string, string>;
};

const workbenchGlobals = globalThis as WorkbenchGlobals;
export const sessionModes =
  workbenchGlobals.__workbenchSessionModes ?? new Map<string, WorkbenchMode>();
workbenchGlobals.__workbenchSessionModes = sessionModes;
export const sessionProjects =
  workbenchGlobals.__workbenchSessionProjects ?? new Map<string, string>();
workbenchGlobals.__workbenchSessionProjects = sessionProjects;

const PAUSE_AFTER_MS = 30_000; // 断连 30s 标记 paused
const DESTROY_AFTER_MS = 120_000; // paused 2min 销毁

export interface ManagedSession {
  id: string;
  session: AgentSession;
  project: string;
  mode: WorkbenchMode;
  paused: boolean;
  pauseTimer?: NodeJS.Timeout;
  destroyTimer?: NodeJS.Timeout;
}

export interface ForkPoint {
  entryId: string;
  text: string;
}

export interface ForkTreeRow {
  id: string;
  parentId: string | null;
  depth: number;
  kind: string;
  role: string;
  text: string;
  label?: string;
  branchable: boolean;
  current: boolean;
  onCurrentPath: boolean;
  childCount: number;
}

export interface ForkTreeState {
  points: ForkPoint[];
  rows: ForkTreeRow[];
  leafId: string | null;
  currentPathIds: string[];
  totalEntries: number;
  branchableCount: number;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => String(part.text ?? ""))
      .join("");
  }
  return "";
}

function shortText(text: string, max = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function displayEntry(entry: SessionEntry, fallbackText?: string): { kind: string; role: string; text: string } | null {
  if (entry.type === "message") {
    const msg = (entry as any).message;
    const role = String(msg?.role ?? "message");
    const text = shortText(fallbackText ?? textFromContent(msg?.content));
    if (!text) return null;
    return { kind: role === "user" || role === "assistant" ? role : "message", role, text };
  }
  if (entry.type === "custom_message") {
    const text = shortText(textFromContent((entry as any).content));
    if (!text) return null;
    return { kind: "custom", role: "custom", text };
  }
  if (entry.type === "branch_summary") {
    const text = shortText((entry as any).summary ?? "");
    if (!text) return null;
    return { kind: "summary", role: "summary", text };
  }
  if (entry.type === "compaction") {
    const text = shortText((entry as any).summary ?? "");
    if (!text) return null;
    return { kind: "compaction", role: "summary", text: `上下文压缩: ${text}` };
  }
  return null;
}

function fallbackForkRows(points: ForkPoint[], leafId: string | null): ForkTreeRow[] {
  return points.map((point, index) => ({
    id: point.entryId,
    parentId: index > 0 ? points[index - 1].entryId : null,
    depth: index,
    kind: "user",
    role: "user",
    text: shortText(point.text),
    branchable: true,
    current: point.entryId === leafId,
    onCurrentPath: point.entryId === leafId,
    childCount: 0,
  }));
}

function flattenForkTree(
  roots: SessionTreeNode[],
  points: ForkPoint[],
  leafId: string | null,
  currentPathIds: Set<string>,
): ForkTreeRow[] {
  const branchableById = new Map(points.map((p) => [p.entryId, p.text]));
  const rows: ForkTreeRow[] = [];
  const stack = roots
    .slice()
    .reverse()
    .map((node) => ({ node, depth: 0 }));

  while (stack.length) {
    const { node, depth } = stack.pop()!;
    const branchableText = branchableById.get(node.entry.id);
    const display = displayEntry(node.entry, branchableText);
    if (display) {
      rows.push({
        id: node.entry.id,
        parentId: node.entry.parentId,
        depth,
        kind: display.kind,
        role: display.role,
        text: display.text,
        label: node.label,
        branchable: branchableById.has(node.entry.id),
        current: node.entry.id === leafId,
        onCurrentPath: currentPathIds.has(node.entry.id),
        childCount: node.children.length,
      });
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], depth: depth + 1 });
    }
  }

  if (leafId && !rows.some((row) => row.current)) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].onCurrentPath) {
        rows[i].current = true;
        break;
      }
    }
  }

  return rows.length ? rows : fallbackForkRows(points, leafId);
}

export class SessionStore {
  private sessions = new Map<string, ManagedSession>();

  /** 创建或恢复 session。失败时抛出,由调用方转成错误页/toast。 */
  async create(project: string, mode: WorkbenchMode, resumeSessionId?: string): Promise<ManagedSession> {
    const projectName = normalizeProjectName(project);
    await createProject(projectName);
    const projectCwd = projectDir(projectName);

    if (resumeSessionId) {
      const existing = this.sessions.get(resumeSessionId);
      if (existing) {
        existing.project = projectName;
        existing.mode = mode;
        existing.paused = false;
        sessionModes.set(existing.id, mode);
        sessionProjects.set(existing.id, projectName);
        return existing;
      }
    }

    const sessionManager = resumeSessionId
      ? SessionManager.open(await this.requireSessionPath(resumeSessionId), undefined, projectCwd)
      : SessionManager.create(projectCwd);

    const { session } = await createAgentSession({
      cwd: projectCwd,
      sessionManager,
      // 默认读取 ~/.pi/agent 的 auth/models/extensions
    });
    const id = session.sessionId;
    sessionModes.set(id, mode);
    sessionProjects.set(id, projectName);
    await recordProjectSession(projectName, id);
    const managed: ManagedSession = { id, session, project: projectName, mode, paused: false };
    this.sessions.set(id, managed);
    return managed;
  }

  private async requireSessionPath(sessionId: string): Promise<string> {
    const path = await findSessionPath(sessionId);
    if (!path) throw new Error(`session not found: ${sessionId}`);
    return path;
  }

  /** 切换模式:更新 sessionModes Map,影响该 session 下一次 before_agent_start。 */
  setMode(id: string, mode: WorkbenchMode): void {
    const m = this.sessions.get(id);
    if (!m) return;
    m.mode = mode;
    sessionModes.set(id, mode);
  }

  /**
   * 分叉树数据:返回可分叉的用户消息点 + 当前 leaf 位置。
   * Pi 的会话树是单文件内 entry 树,每个用户消息是一个可回溯的分叉点。
   */
  forkPoints(id: string): ForkTreeState {
    const m = this.sessions.get(id);
    if (!m) return { points: [], rows: [], leafId: null, currentPathIds: [], totalEntries: 0, branchableCount: 0 };
    const points = m.session.getUserMessagesForForking?.() ?? [];
    const leafId = m.session.sessionManager?.getLeafId?.() ?? null;
    const currentPathIds = new Set<string>();
    try {
      for (const entry of m.session.sessionManager?.getBranch?.(leafId ?? undefined) ?? []) {
        currentPathIds.add(entry.id);
      }
    } catch {
      if (leafId) currentPathIds.add(leafId);
    }
    const roots = m.session.sessionManager?.getTree?.() ?? [];
    const rows = roots.length
      ? flattenForkTree(roots, points, leafId, currentPathIds)
      : fallbackForkRows(points, leafId);
    return {
      points,
      rows,
      leafId,
      currentPathIds: [...currentPathIds],
      totalEntries: m.session.sessionManager?.getEntries?.().length ?? rows.length,
      branchableCount: points.length,
    };
  }

  /**
   * 分叉:把 leaf 移到某个历史用户消息处。之后再 prompt 就从那里长出新分支。
   * navigateTree 在同一 session 文件内移动,不创建新 session(Pi 的设计)。
   */
  async fork(id: string, targetEntryId: string): Promise<void> {
    const m = this.sessions.get(id);
    if (!m) throw new Error("session not found");
    await m.session.navigateTree(targetEntryId);
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /** 返回任一活跃 session(手机无 sessionId 时用),没有则返回 undefined。 */
  any(): ManagedSession | undefined {
    for (const m of this.sessions.values()) return m;
    return undefined;
  }

  list(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /** WebSocket 断连:启动 30s → paused → 再 2min → 销毁 的定时链。 */
  onDisconnect(id: string): void {
    const m = this.sessions.get(id);
    if (!m) return;
    this.clearTimers(m);
    m.pauseTimer = setTimeout(() => {
      m.paused = true;
      m.destroyTimer = setTimeout(() => this.destroy(id), DESTROY_AFTER_MS);
    }, PAUSE_AFTER_MS);
  }

  /** WebSocket 重连:取消暂停/销毁定时器,恢复 session。 */
  onReconnect(id: string): ManagedSession | undefined {
    const m = this.sessions.get(id);
    if (!m) return undefined;
    this.clearTimers(m);
    m.paused = false;
    return m;
  }

  private clearTimers(m: ManagedSession): void {
    if (m.pauseTimer) clearTimeout(m.pauseTimer);
    if (m.destroyTimer) clearTimeout(m.destroyTimer);
    m.pauseTimer = undefined;
    m.destroyTimer = undefined;
  }

  private destroy(id: string): void {
    const m = this.sessions.get(id);
    if (!m) return;
    this.clearTimers(m);
    void m.session.abort().catch(() => {});
    this.sessions.delete(id);
    sessionModes.delete(id);
    sessionProjects.delete(id);
    console.log(`[session] destroyed ${id} (idle timeout)`);
  }
}
