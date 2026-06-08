import { describe, expect, it } from "vitest";
import { analyzeArtifactQuality } from "./quality.ts";

describe("analyzeArtifactQuality", () => {
  it("marks structured markdown with a conclusion as ready", () => {
    const content = [
      "# PRD",
      "## 背景",
      "这个产品方案面向真实用户，描述目标、范围、流程、指标和风险。",
      "它包含足够的上下文，用于团队评审、执行拆解和验收沟通。",
      "## 方案",
      "我们会定义核心场景、用户路径、关键约束、边界条件和成功指标。",
      "每个模块都应该有可验证的输入输出，并且能够被后续任务追踪。",
      "## 结论",
      "下一步是确认优先级、风险和验收标准，然后保存为可交付文档。",
    ].join("\n\n");

    const quality = analyzeArtifactQuality("prd.md", content);

    expect(quality.status).toBe("ready");
    expect(quality.score).toBeGreaterThanOrEqual(80);
  });

  it("warns on thin markdown", () => {
    const quality = analyzeArtifactQuality("brief.md", "# Brief\n\n太短。");

    expect(quality.status).toBe("needs-work");
    expect(quality.issues.some((issue) => issue.level === "warning")).toBe(true);
  });

  it("reports inconsistent CSV columns as an error", () => {
    const quality = analyzeArtifactQuality("data.csv", "a,b\n1,2\n3");

    expect(quality.status).toBe("error");
    expect(quality.issues.some((issue) => issue.message.includes("列数"))).toBe(true);
  });

  it("reports invalid JSON as an error", () => {
    const quality = analyzeArtifactQuality("data.json", "{ nope");

    expect(quality.status).toBe("error");
    expect(quality.issues.some((issue) => issue.message.includes("JSON"))).toBe(true);
  });
});

