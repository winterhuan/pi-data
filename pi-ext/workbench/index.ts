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
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// workspace 根目录:环境变量优先(server 设置),否则默认仓库内 workbench/workspace
const WORKSPACE =
  process.env.WORKBENCH_WORKSPACE ??
  join(process.cwd(), "workbench", "workspace");

// 当前模式存在全局,server 创建 session 后通过 globalThis 设置
type Mode = "work" | "create";
function currentMode(): Mode {
  return ((globalThis as any).__workbenchMode as Mode) ?? "create";
}

const WORK_PROMPT =
  "你现在处于「工作模式」。优先用 bash/read/write 处理文件、运行脚本、分析数据。" +
  "产物(分析报告、代码说明)用 save_artifact 存为 markdown,数据存为 csv。直接、精确、可复现。";

const CREATE_PROMPT =
  "你现在处于「创作模式」。帮用户创作散文、论文、小说、短剧、电影剧本。" +
  "剧本/电影用 Fountain 格式(场景标题大写、角色名居中),用 save_artifact 存为 .fountain;" +
  "其余文学作品用 Markdown 存为 .md。注重结构、文学性和情感真实。";

function safeSeg(s: string): string {
  return s.replace(/[/\\]/g, "_").trim() || "未命名";
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
      const project = safeSeg(params.project);
      const dir = join(WORKSPACE, project);
      const ts = new Date().toISOString();

      await mkdir(join(dir, "artifacts"), { recursive: true });
      await mkdir(join(dir, "sessions"), { recursive: true });

      const file = safeSeg(params.filename);
      await writeFile(join(dir, "artifacts", file), params.content);

      // meta.json
      const metaPath = join(dir, "meta.json");
      let meta: any;
      try {
        meta = JSON.parse(await readFile(metaPath, "utf-8"));
      } catch {
        meta = { name: project, type: params.type, created: ts };
      }
      meta.lastUpdated = ts;
      meta.type = params.type;
      await writeFile(metaPath, JSON.stringify(meta, null, 2));

      // index.json(按 name 去重)
      const indexPath = join(WORKSPACE, "index.json");
      let index: any[];
      try {
        index = JSON.parse(await readFile(indexPath, "utf-8"));
      } catch {
        index = [];
      }
      const found = index.find((e) => e.name === project);
      if (found) {
        found.lastUpdated = ts;
        found.type = params.type;
      } else {
        index.push({ id: project, name: project, type: params.type, lastUpdated: ts });
      }
      await mkdir(WORKSPACE, { recursive: true });
      await writeFile(indexPath, JSON.stringify(index, null, 2));

      return {
        content: [{ type: "text", text: `已保存到 ${project}/${file}` }],
        details: { project, file, type: params.type },
      };
    },
  });

  // 按模式注入 system prompt
  pi.on("before_agent_start", async (event: any) => {
    const extra = currentMode() === "work" ? WORK_PROMPT : CREATE_PROMPT;
    const opts = event.systemPromptOptions;
    if (opts) {
      opts.customPrompt = opts.customPrompt ? `${opts.customPrompt}\n\n${extra}` : extra;
    }
  });
}
