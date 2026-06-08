export interface ArtifactQualityIssue {
  level: "ok" | "warning" | "error";
  message: string;
}

export interface ArtifactQuality {
  status: "ready" | "needs-work" | "error";
  score: number;
  words: number;
  lines: number;
  headings: number;
  issues: ArtifactQualityIssue[];
}

function artifactKind(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".fountain")) return "screenplay";
  return "text";
}

function countWords(content: string): number {
  const latin = content.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;
  const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return latin + cjk;
}

function scoreFromIssues(issues: ArtifactQualityIssue[]): number {
  const penalty = issues.reduce((sum, issue) => sum + (issue.level === "error" ? 35 : issue.level === "warning" ? 15 : 0), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function analyzeArtifactQuality(filename: string, content: string): ArtifactQuality {
  const text = String(content ?? "");
  const trimmed = text.trim();
  const kind = artifactKind(filename);
  const lines = trimmed ? trimmed.split(/\r?\n/).length : 0;
  const words = countWords(trimmed);
  const headings = (trimmed.match(/^#{1,6}\s+\S+/gm) ?? []).length;
  const issues: ArtifactQualityIssue[] = [];

  if (!trimmed) {
    issues.push({ level: "error", message: "产物为空，不能交付。" });
  }

  if (kind === "markdown") {
    if (words < 120) issues.push({ level: "warning", message: "正文偏短，建议补充背景、结论和下一步。" });
    if (headings < 2) issues.push({ level: "warning", message: "结构偏弱，建议增加二级标题或清晰分段。" });
    if (!/结论|总结|下一步|验收|建议|风险|Conclusion|Next/i.test(trimmed)) {
      issues.push({ level: "warning", message: "缺少结论、建议、风险或下一步等交付收束。" });
    }
  } else if (kind === "csv") {
    const rows = trimmed ? trimmed.split(/\r?\n/) : [];
    const widths = rows.map((row) => row.split(",").length);
    if (rows.length < 2) issues.push({ level: "warning", message: "CSV 只有表头或内容不足，建议至少包含一行示例数据。" });
    if (new Set(widths).size > 1) issues.push({ level: "error", message: "CSV 每行列数不一致，可能无法可靠导入。" });
  } else if (kind === "json") {
    try {
      JSON.parse(trimmed || "null");
    } catch {
      issues.push({ level: "error", message: "JSON 解析失败，请修复格式后再交付。" });
    }
  } else if (kind === "screenplay") {
    if (lines < 12) issues.push({ level: "warning", message: "剧本偏短，建议补充分场、动作和对白。" });
    if (!/\b(INT|EXT)\.|\b(内景|外景)/i.test(trimmed)) {
      issues.push({ level: "warning", message: "缺少明显场景标题，建议使用 Fountain 场景格式。" });
    }
  } else if (words < 80) {
    issues.push({ level: "warning", message: "内容偏短，建议补充可交付细节。" });
  }

  if (!issues.length) issues.push({ level: "ok", message: "结构和格式看起来可以交付。" });
  const score = scoreFromIssues(issues);
  return {
    status: issues.some((issue) => issue.level === "error") ? "error" : score >= 80 ? "ready" : "needs-work",
    score,
    words,
    lines,
    headings,
    issues,
  };
}

