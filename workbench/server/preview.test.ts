/**
 * preview.test.ts — preview.ts 渲染器单元测试(纯函数,无需 API key)
 *
 * 覆盖: Markdown 渲染、Fountain 剧本渲染、CSV 表格、未知类型 fallback、
 * 渲染失败降级。这是 T14 的「无 key 即可跑」部分,也是 Pi 升级后的回归基线。
 */

import { describe, it, expect } from "vitest";
import { renderArtifact } from "./preview.ts";

describe("renderArtifact", () => {
  it("renders markdown to prose article", () => {
    const html = renderArtifact("story.md", "# 标题\n\n一段正文。");
    expect(html).toContain("artifact-prose");
    expect(html).toContain("<h1");
    expect(html).toContain("标题");
  });

  it("renders fountain to screenplay", () => {
    const fountain = "INT. 房间 - 日\n\n小明走进来。\n\n小明\n你好。";
    const html = renderArtifact("scene.fountain", fountain);
    expect(html).toContain("artifact-screenplay");
  });

  it("renders csv to table", () => {
    const html = renderArtifact("data.csv", "名字,年龄\n小明,20\n小红,22");
    expect(html).toContain("artifact-table");
    expect(html).toContain("<th>名字</th>");
    expect(html).toContain("<td>小明</td>");
  });

  it("falls back to <pre> for unknown extension", () => {
    const html = renderArtifact("notes.txt", "纯文本内容");
    expect(html).toContain("artifact-raw");
    expect(html).toContain("纯文本内容");
  });

  it("escapes html in fallback to prevent injection", () => {
    const html = renderArtifact("x.txt", "<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes raw html in markdown preview", () => {
    const html = renderArtifact("x.md", "# Hi\n\n<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes html in csv cells", () => {
    const html = renderArtifact("x.csv", "a,b\n<b>x</b>,y");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
