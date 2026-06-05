/**
 * 工作台连接器扩展 (workbench)
 *
 * 问题: 工作台需要两个能力 Pi 默认没有:
 *   1. save_artifact —— 把创作/工作产物按 project 落地到 workspace/,供前端活页本
 *      预览和档案室浏览。
 *   2. 工作/创作模式 —— 同一个台子既做冷静的数据/代码工作,又做热的文学/剧本创作,
 *      两种模式需要不同的 system prompt 引导。
 *
 * 方案: 一个 Pi 扩展,匹配 multi-api-key / hide-hf 的写法(ExtensionAPI、事件驱动)。
 *   - registerTool("save_artifact") → 写文件 + 更新 meta.json/index.json
 *   - on("before_agent_start") → 按当前模式注入 system prompt
 *   模式存在 globalThis 上,由 server 在创建 session 后设置(SDK 同进程)。
 *
 * 部署: symlink 本目录到 ~/.pi/agent/extensions/workbench(见 README)。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// workspace 根目录:环境变量优先(server 设置),否则默认仓库内 workbench/workspace
const WORKSPACE =
  process.env.WORKBENCH_WORKSPACE ??
  join(process.cwd(), "workbench", "workspace");
const WORKSPACE_ROOT = resolve(WORKSPACE);

// 当前模式从 sessionModes Map 读取,支持并发 session 各自独立模式
type Mode = "work" | "create";
type WorkbenchGlobals = typeof globalThis & {
  __workbenchSessionModes?: Map<string, Mode>;
};

function sessionModes(): Map<string, Mode> {
  const g = globalThis as WorkbenchGlobals;
  return g.__workbenchSessionModes ?? new Map<string, Mode>();
}

function currentMode(sessionId?: string): Mode {
  const modes = sessionModes();
  if (sessionId) return modes.get(sessionId) ?? "create";
  // fallback: 取最近设置的模式
  const last = [...modes.values()].pop();
  return last ?? "create";
}

async function readIndex(): Promise<Array<{ id: string; name: string; type: string; lastUpdated: string }>> {
  try {
    return JSON.parse(await readFile(workspacePath("index.json"), "utf-8"));
  } catch {
    return [];
  }
}

let indexLock: Promise<void> = Promise.resolve();
async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = indexLock;
  let unlock!: () => void;
  indexLock = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    unlock();
  }
}

async function saveArtifact(opts: {
  project: string;
  type: string;
  filename: string;
  content: string;
  timestamp: string;
}): Promise<void> {
  const project = safeSeg(opts.project);
  const dir = workspacePath(project);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });

  const file = safeSeg(opts.filename) || "artifact.txt";
  await writeFile(join(dir, "artifacts", file), opts.content);

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

  await withIndexLock(async () => {
    const index = await readIndex();
    const existing = index.find((e) => e.name === opts.project);
    if (existing) {
      existing.lastUpdated = opts.timestamp;
      existing.type = opts.type;
    } else {
      index.push({ id: opts.project, name: opts.project, type: opts.type, lastUpdated: opts.timestamp });
    }
    await mkdir(WORKSPACE_ROOT, { recursive: true });
    await writeFile(workspacePath("index.json"), JSON.stringify(index, null, 2));
  });
}

const WORK_PROMPT =
  "你现在处于「工作模式」。优先用 bash/read/write 处理文件、运行脚本、分析数据。" +
  "产物(分析报告、代码说明)用 save_artifact 存为 markdown,数据存为 csv。直接、精确、可复现。";

const CREATE_PROMPT =
  "你现在处于「创作模式」。帮用户创作散文、论文、小说、短剧、电影剧本。" +
  "剧本/电影用 Fountain 格式(场景标题大写、角色名居中),用 save_artifact 存为 .fountain;" +
  "其余文学作品用 Markdown 存为 .md。注重结构、文学性和情感真实。" +
  "写长篇(多章节小说/剧本/电影)时,先用 read_bible 调取该作品的人物/大纲/世界观/伏笔," +
  "保持前后一致;新增设定用 save_bible 存档,确保埋下的伏笔后续能收回。";

function safeSeg(s: string): string {
  return s.replace(/\.\./g, "_").replace(/[/\\]/g, "_").trim() || "未命名";
}

function workspacePath(...segs: string[]): string {
  const target = resolve(WORKSPACE_ROOT, ...segs);
  if (target !== WORKSPACE_ROOT && !target.startsWith(WORKSPACE_ROOT + "/")) {
    throw new Error("invalid workspace path");
  }
  return target;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "save_artifact",
    label: "保存产物",
    description:
      "把创作或工作产物保存到工作台档案室。用户能在活页本预览面板看到渲染结果,并能扫码在手机上查看。",
    promptSnippet:
      "完成一段值得保留的作品(文章/小说/剧本/分析报告)后,用 save_artifact 保存它。",
    promptGuidelines: [
      "写完小说/散文/论文用 save_artifact 存为 .md;写完剧本/电影存为 .fountain;数据分析结果存为 .csv。",
      "save_artifact 的 project 用一个有意义的作品名,同一作品的多个产物用同一个 project。",
    ],
    parameters: Type.Object({
      project: Type.String({ description: "项目/作品名,如「我的第一部短剧」" }),
      type: Type.Union([
        Type.Literal("markdown"),
        Type.Literal("fountain"),
        Type.Literal("csv"),
      ]),
      filename: Type.String({ description: "文件名,含扩展名,如 scene1.fountain" }),
      content: Type.String({ description: "产物完整内容" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      await saveArtifact({
        project: params.project,
        type: params.type,
        filename: params.filename,
        content: params.content,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: `已保存到 ${params.project}/${params.filename}` }],
        details: { project: params.project, file: params.filename, type: params.type },
      };
    },
  });

  // ── 长篇结构化大脑(创作圣经)──────────────────────────────
  // 问题: 写长篇(小说/剧本/电影)时,AI 记不住第 3 章埋的伏笔要在第 18 章收,
  //   也记不住人物设定、世界观规则。上下文窗口装不下整本书。
  // 方案: 把结构化设定存进 project 的 bible/ 子目录(与正文 artifacts/ 分开)。
  //   save_bible 写入,read_bible 在创作前读回全部设定 → 注入上下文。

  const BIBLE_KINDS = ["character", "outline", "worldbuilding", "foreshadowing"] as const;

  pi.registerTool({
    name: "save_bible",
    label: "保存创作设定",
    description:
      "保存长篇作品的结构化设定:人物表、章节大纲、世界观、伏笔追踪。这些是「创作圣经」," +
      "与正文分开存放,供后续章节创作时调取,保证长篇前后一致(如第 3 章的伏笔在第 18 章收回)。",
    promptSnippet:
      "写长篇小说/剧本/电影时,把人物、大纲、世界观、伏笔用 save_bible 存为设定,后续章节据此保持一致。",
    promptGuidelines: [
      "新增/更新人物用 save_bible kind=character;章节大纲用 outline;世界观规则用 worldbuilding;埋下或回收伏笔用 foreshadowing。",
      "同一作品的设定和正文用同一个 project 名。写新章节前先 read_bible 调取已有设定。",
    ],
    parameters: Type.Object({
      project: Type.String({ description: "作品名,与正文 save_artifact 用同一个" }),
      kind: Type.Union(BIBLE_KINDS.map((k) => Type.Literal(k))),
      name: Type.String({ description: "条目名,如「主角-林越」「第三章大纲」「伏笔-那枚旧怀表」" }),
      content: Type.String({ description: "设定内容(Markdown)" }),
    }),
    async execute(_id, params, _s, _u, _ctx: ExtensionContext) {
      const project = safeSeg(params.project);
      const dir = workspacePath(project, "bible", params.kind);
      await mkdir(dir, { recursive: true });
      const file = safeSeg(params.name) + ".md";
      await writeFile(join(dir, file), params.content);
      return {
        content: [{ type: "text", text: `已存入创作圣经:${project}/${params.kind}/${file}` }],
        details: { project, kind: params.kind, name: params.name },
      };
    },
  });

  pi.registerTool({
    name: "read_bible",
    label: "读取创作设定",
    description:
      "读回某作品的全部创作圣经(人物表、大纲、世界观、伏笔)。写新章节、保持长篇一致性前先调用它。",
    promptSnippet: "继续写长篇前,先用 read_bible 调取该作品的人物/大纲/世界观/伏笔设定。",
    promptGuidelines: [
      "写长篇作品的新章节、新场景前,先 read_bible 确认人物设定和未回收的伏笔。",
    ],
    parameters: Type.Object({
      project: Type.String({ description: "作品名" }),
    }),
    async execute(_id, params, _s, _u, _ctx: ExtensionContext) {
      const project = safeSeg(params.project);
      const bibleDir = workspacePath(project, "bible");
      const sections: string[] = [];
      for (const kind of BIBLE_KINDS) {
        const kindDir = workspacePath(project, "bible", kind);
        let files: string[];
        try {
          files = await readdir(kindDir);
        } catch {
          continue;
        }
        if (!files.length) continue;
        const label = { character: "人物", outline: "大纲", worldbuilding: "世界观", foreshadowing: "伏笔" }[kind];
        const parts: string[] = [`## ${label}`];
        for (const f of files) {
          const body = await readFile(join(kindDir, f), "utf-8");
          parts.push(`### ${f.replace(/\.md$/, "")}\n${body}`);
        }
        sections.push(parts.join("\n\n"));
      }
      const text = sections.length
        ? `# 《${project}》创作圣经\n\n${sections.join("\n\n---\n\n")}`
        : `《${project}》还没有任何创作设定。`;
      return {
        content: [{ type: "text", text }],
        details: { project, kinds: BIBLE_KINDS.filter(() => true) },
      };
    },
  });

  // 按模式注入 system prompt
  pi.on("before_agent_start", async (event: any) => {
    const sessionId = event.sessionId ?? event.session?.id;
    const extra = currentMode(sessionId) === "work" ? WORK_PROMPT : CREATE_PROMPT;
    const opts = event.systemPromptOptions;
    if (opts) {
      opts.customPrompt = opts.customPrompt ? `${opts.customPrompt}\n\n${extra}` : extra;
    }
  });
}
