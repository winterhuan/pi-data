export interface DeliverableDefinition {
  id: string;
  title: string;
  description: string;
  prompt: string;
  artifactTypes?: string[];
  filenameKeywords?: string[];
}

export interface DeliverableStatus extends DeliverableDefinition {
  done: boolean;
  matchedFile: string | null;
}

const DEFAULT_DELIVERABLES: DeliverableDefinition[] = [
  {
    id: "primary-doc",
    title: "主文档",
    description: "一份可交付的 Markdown 正文、方案或总结。",
    prompt: "请补齐这个项目的主文档：先概括目标和受众，再输出一份结构完整、可直接交付的 Markdown 文档，并保存为产物。",
    artifactTypes: ["markdown"],
  },
  {
    id: "supporting-data",
    title: "结构化材料",
    description: "表格、清单、JSON 或其他可继续加工的数据。",
    prompt: "请为这个项目补齐结构化材料：整理关键字段、条目或数据模板，输出 CSV 或 JSON，并保存为产物。",
    artifactTypes: ["csv", "json"],
  },
];

const DELIVERABLES_BY_TYPE: Record<string, DeliverableDefinition[]> = {
  novel: [
    {
      id: "chapter-draft",
      title: "章节草稿",
      description: "可继续润色的章节正文。",
      prompt: "请补齐章节草稿：基于当前项目设定写一章可继续润色的小说正文，使用 Markdown，并保存为章节产物。",
      artifactTypes: ["markdown"],
      filenameKeywords: ["chapter", "draft", "章节", "正文"],
    },
    {
      id: "story-bible",
      title: "设定沉淀",
      description: "世界观、角色或大纲等长期设定材料。",
      prompt: "请补齐设定沉淀：整理世界观、角色关系、关键冲突和后续大纲，保存为项目设定或 Markdown 产物。",
      filenameKeywords: ["bible", "setting", "outline", "设定", "大纲", "角色"],
    },
  ],
  screenplay: [
    {
      id: "script",
      title: "剧本正文",
      description: "Fountain 或文本格式的可拍摄剧本。",
      prompt: "请补齐剧本正文：基于项目已有方向写出可拍摄的 Fountain 格式剧本或分场正文，并保存为产物。",
      artifactTypes: ["screenplay", "text"],
      filenameKeywords: ["script", "scene", "fountain", "剧本", "分场"],
    },
    {
      id: "outline",
      title: "故事大纲",
      description: "人物、冲突和分场结构。",
      prompt: "请补齐故事大纲：整理人物、核心冲突、三段结构和分场安排，输出 Markdown 并保存为产物。",
      artifactTypes: ["markdown"],
      filenameKeywords: ["outline", "story", "大纲", "人物"],
    },
  ],
  product: [
    {
      id: "prd",
      title: "PRD / 方案",
      description: "目标用户、范围、流程、验收标准完整的方案文档。",
      prompt: "请补齐 PRD / 产品方案：包含目标用户、核心场景、范围、用户流程、成功指标、风险和验收标准，输出 Markdown 并保存为产物。",
      artifactTypes: ["markdown"],
      filenameKeywords: ["prd", "product", "plan", "方案", "需求"],
    },
    {
      id: "risks",
      title: "风险与验收",
      description: "风险清单、指标或验收条件。",
      prompt: "请补齐风险与验收材料：列出主要风险、缓解方案、成功指标和验收条件，可用 Markdown 或 CSV，并保存为产物。",
      artifactTypes: ["markdown", "csv"],
      filenameKeywords: ["risk", "acceptance", "验收", "风险", "指标"],
    },
  ],
  analysis: [
    {
      id: "report",
      title: "分析报告",
      description: "问题、指标、结论和建议完整的报告。",
      prompt: "请补齐分析报告：说明业务问题、数据口径、指标体系、关键发现、结论和建议，输出 Markdown 并保存为产物。",
      artifactTypes: ["markdown"],
      filenameKeywords: ["report", "analysis", "报告", "分析"],
    },
    {
      id: "metrics-table",
      title: "指标表",
      description: "CSV 或 JSON 格式的指标、字段或数据模板。",
      prompt: "请补齐指标表：设计指标、字段、口径、示例值和用途，输出 CSV 或 JSON，并保存为产物。",
      artifactTypes: ["csv", "json"],
      filenameKeywords: ["metrics", "data", "csv", "指标", "数据"],
    },
  ],
  brief: [
    {
      id: "summary",
      title: "摘要",
      description: "可对外同步的一页总结。",
      prompt: "请补齐会议摘要：整理背景、关键决定、未决问题和对外同步口径，输出一页 Markdown 并保存为产物。",
      artifactTypes: ["markdown"],
      filenameKeywords: ["brief", "summary", "memo", "摘要", "复盘"],
    },
    {
      id: "actions",
      title: "行动项",
      description: "负责人、截止时间和后续跟进事项。",
      prompt: "请补齐行动项：提炼任务、负责人、截止时间、依赖和跟进方式，可用 Markdown 或 CSV，并保存为产物。",
      artifactTypes: ["markdown", "csv"],
      filenameKeywords: ["action", "todo", "follow", "行动", "待办"],
    },
  ],
};

export function deliverablesForType(type: string): DeliverableDefinition[] {
  return DELIVERABLES_BY_TYPE[String(type || "").toLowerCase()] ?? DEFAULT_DELIVERABLES;
}
