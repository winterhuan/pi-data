/**
 * preview.ts — 产物渲染为可分享 HTML
 *
 * 问题: 产物要在右侧活页本面板和 /preview/:id 页面渲染。小说是阅读页、
 * 剧本是规范剧本排版、数据是表格/代码块。渲染失败要降级显示原文(不空白)。
 *
 * 方案: 按文件扩展名分发到对应渲染器。纯函数,便于单元测试(T14)。
 *   .md       → marked.js → 阅读页
 *   .fountain → fountain-js → 规范剧本页
 *   .csv      → 简单表格
 *   其他       → <pre> 代码块
 *
 * 任何渲染器抛错 → fallback 到 <pre> 原文(降级,不静默)。
 */

import { marked } from "marked";
import { Fountain } from "fountain-js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function fallback(content: string): string {
  return `<pre class="artifact-raw">${escapeHtml(content)}</pre>`;
}

function safeUrl(raw: string): string | null {
  const value = raw.trim();
  const compact = value.replace(/[\u0000-\u001F\u007F\s]+/g, "");
  const scheme = compact.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    return ["http", "https", "mailto", "tel"].includes(protocol) ? escapeHtml(value) : null;
  }
  if (compact.startsWith("//")) return null;
  return escapeHtml(value);
}

function renderMarkdown(content: string): string {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = function ({ href, title, tokens }) {
    const cleanHref = safeUrl(href);
    const label = this.parser.parseInline(tokens);
    if (!cleanHref) return label;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${cleanHref}"${titleAttr} rel="noopener noreferrer">${label}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    const cleanHref = safeUrl(href);
    if (!cleanHref) return escapeHtml(text);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${cleanHref}" alt="${escapeHtml(text)}"${titleAttr}>`;
  };
  return `<article class="artifact-prose">${marked.parse(content, { async: false, renderer }) as string}</article>`;
}

function renderFountain(content: string): string {
  const out = new Fountain().parse(content);
  // fountain-js 返回 {html:{title_page, script}};用 script 作为剧本正文
  const script = (out as any)?.html?.script ?? "";
  if (!script) throw new Error("fountain parse produced no script");
  return `<div class="artifact-screenplay">${script}</div>`;
}

function renderCsv(content: string): string {
  const rows = content.trim().split(/\r?\n/).map((r) => r.split(","));
  const cells = (cs: string[], tag: string) =>
    cs.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("");
  const [head, ...body] = rows;
  const thead = head ? `<thead><tr>${cells(head, "th")}</tr></thead>` : "";
  const tbody = `<tbody>${body.map((r) => `<tr>${cells(r, "td")}</tr>`).join("")}</tbody>`;
  return `<table class="artifact-table">${thead}${tbody}</table>`;
}

/**
 * 按文件名渲染产物。任何渲染失败都降级到原文 <pre>,绝不抛出/空白。
 */
export function renderArtifact(filename: string, content: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  try {
    switch (ext) {
      case ".md":
      case ".markdown":
        return renderMarkdown(content);
      case ".fountain":
        return renderFountain(content);
      case ".csv":
        return renderCsv(content);
      default:
        return fallback(content);
    }
  } catch (err) {
    console.error(`[preview] render failed for ${filename}: ${(err as Error).message}`);
    return fallback(content);
  }
}
