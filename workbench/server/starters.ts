export interface StarterTemplate {
  id: string;
  title: string;
  description: string;
  mode: "create" | "work";
  projectType: string;
  suggestedProjectName: string;
  prompt: string;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: "novel-chapter",
    title: "小说章节",
    description: "先生成设定和第一章草稿，适合长篇创作开局。",
    mode: "create",
    projectType: "novel",
    suggestedProjectName: "长篇小说",
    prompt: "请帮我创建一个长篇小说项目。先追问我 3 个关键问题，然后产出世界观设定、主角设定、三幕式大纲，并写出第一章草稿。请把设定保存为 bible，把第一章保存为 Markdown 产物。",
  },
  {
    id: "screenplay-scene",
    title: "短片剧本",
    description: "快速做人物关系、场景设计和 Fountain 剧本。",
    mode: "create",
    projectType: "screenplay",
    suggestedProjectName: "短片剧本",
    prompt: "请帮我做一个 5 分钟短片剧本。先确定主题、人物和冲突，然后产出故事梗概、分场大纲，并保存一版 Fountain 格式剧本产物。",
  },
  {
    id: "product-plan",
    title: "产品方案",
    description: "把模糊需求变成可执行 PRD、范围和验收标准。",
    mode: "work",
    projectType: "product",
    suggestedProjectName: "产品方案",
    prompt: "请把我的想法整理成一个可执行产品方案。先追问目标用户、核心场景和成功指标，然后输出 PRD、MVP 范围、用户流程、风险清单和验收标准，并保存为 Markdown 产物。",
  },
  {
    id: "data-report",
    title: "数据报告",
    description: "生成分析框架、指标表和结论页。",
    mode: "work",
    projectType: "analysis",
    suggestedProjectName: "数据分析",
    prompt: "请帮我搭建一个数据分析报告。先确认数据来源和业务问题，然后设计指标体系、分析步骤、CSV 表头模板和最终报告结构，并保存一份 Markdown 报告产物。",
  },
  {
    id: "meeting-brief",
    title: "会议复盘",
    description: "把讨论沉淀成行动项、决策和后续跟进。",
    mode: "work",
    projectType: "brief",
    suggestedProjectName: "会议复盘",
    prompt: "请帮我做会议复盘。先让我粘贴会议要点，然后整理决策、未决问题、行动项、负责人、截止日期和一页对外同步摘要，并保存为 Markdown 产物。",
  },
];

export function listStarterTemplates(): StarterTemplate[] {
  return STARTER_TEMPLATES;
}

export function findStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((template) => template.id === id);
}
