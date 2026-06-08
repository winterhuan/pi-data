// app.js — Pi 工作台 v2 前端
//
// 问题: v2 三栏布局,引入项目/会话两级导航,需要明确的状态机防止空白屏和静默失败。
//
// 状态: no-project → loading-project → active
//        active → creating-session → active
//        active → streaming → active
//        any → failed / reconnecting

const $ = (s) => document.querySelector(s);

// ── 状态机 ───────────────────────────────────────────────────────────────
let appState = "no-project";
let ws = null, sessionId = null, activeProject = null;
let mode = "create", curAssistant = null;
let reconnectAttempts = 0, reconnectTimer = null;
let pendingText = null;
let dashboardData = null;
let starterTemplates = [];
let currentArtifact = null;
let artifactEditorMode = "edit";
let artifactEditorProject = null;
const pendingDeliverables = new Set();
const pendingArtifactRefines = new Set();
const PROJECT_TYPE_OPTIONS = [
  { value: "create", label: "通用创作" },
  { value: "work", label: "通用工作" },
  { value: "product", label: "产品方案" },
  { value: "analysis", label: "数据分析" },
  { value: "brief", label: "会议简报" },
  { value: "novel", label: "小说创作" },
  { value: "screenplay", label: "剧本创作" },
];

const STATE_IDS = {
  "no-project": "state-no-project", "loading-project": "state-loading",
  "creating-session": "state-creating", "failed": "state-failed",
  "reconnecting": "state-reconnecting", "active": "state-active", "streaming": "state-active",
};

function setState(s, msg) {
  appState = s;
  const active = STATE_IDS[s];
  Object.values(STATE_IDS).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", id !== active);
  });
  const streaming = s === "streaming";
  document.getElementById("streaming-indicator").classList.toggle("hidden", !streaming);
  document.getElementById("send-btn").disabled = streaming;
  if (s === "failed" && msg) document.getElementById("state-failed-msg").textContent = msg;
  if (s === "reconnecting" && msg) document.getElementById("reconnect-msg").textContent = msg;
  updateTopContext();
}

function updateTopContext(message) {
  const el = document.getElementById("top-context");
  if (!el) return;
  if (message) {
    el.textContent = message;
    return;
  }
  if (activeProject) {
    const label = mode === "work" ? "工作模式" : "创作模式";
    el.textContent = `${activeProject} · ${label}`;
    return;
  }
  const totals = dashboardData?.workspace?.totals;
  if (totals) {
    el.textContent = `${totals.projects} 个项目 · ${totals.artifacts} 个产物`;
    return;
  }
  el.textContent = ws?.readyState === WebSocket.OPEN ? "Pi 已连接" : "准备连接 Pi";
}

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    document.getElementById("conn").classList.add("ok");
    updateTopContext();
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (appState === "reconnecting") setState(activeProject ? "active" : "no-project");
  };
  ws.onclose = () => {
    document.getElementById("conn").classList.remove("ok");
    updateTopContext("连接中断，正在重连");
    if (reconnectAttempts >= 5) { setState("failed", "连接失败，请刷新页面"); return; }
    reconnectAttempts++;
    setState("reconnecting", `重连中 (${reconnectAttempts}/5)…`);
    reconnectTimer = setTimeout(connect, 2000 * reconnectAttempts);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}
function wsSend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── 消息处理 ──────────────────────────────────────────────────────────────
function handle(msg) {
  if (msg.kind === "created") {
    sessionId = msg.sessionId;
    if (msg.mode) { mode = msg.mode; updateModeButtons(); }
    if (msg.project) activeProject = msg.project;
    localStorage.setItem("pi-last-session", sessionId);
    setState("active");
    if (pendingText) { const t = pendingText; pendingText = null; wsSend({ type: "prompt", sessionId, payload: { text: t } }); setState("streaming"); }
    return;
  }
  if (msg.kind === "error") { toast("出错了：" + msg.message); if (appState === "streaming") setState("active"); finishAssistant(); return; }
  if (msg.kind === "fork_points") { renderForkPoints(msg); return; }
  if (msg.kind === "forked") {
    document.getElementById("stream").innerHTML = ""; curAssistant = null;
    renderForkPoints(msg); toast("已分叉，从这里开新线");
    return;
  }
  if (msg.kind === "agent_event") renderEvent(msg.event);
}

// ── 流式渲染 ──────────────────────────────────────────────────────────────
function renderEvent(e) {
  if (e.type === "message_update") {
    const d = e.assistantMessageEvent;
    if (d?.type === "text_delta" && d.delta) {
      if (!curAssistant) curAssistant = addBubble("assistant", "");
      curAssistant.textContent += d.delta;
      document.getElementById("stream").scrollTop = 9e9;
    }
  } else if (e.type === "tool_execution_start") {
    addToolLine(`🔧 ${e.toolName}…`);
  } else if (e.type === "tool_execution_end") {
    if (e.toolName === "save_artifact" && e.result?.details) {
      const { project, file } = e.result.details;
      clearPendingDeliverables(project);
      pendingArtifactRefines.delete(artifactKey(project, file));
      loadPreview(project, file);
      refreshArchive(project);
      refreshOpenProject(project);
      toast(`已保存 ${file}`);
    } else if (e.toolName === "save_bible" && e.result?.details) {
      refreshArchive(e.result.details.project); toast("创作设定已保存");
    }
  } else if (e.type === "agent_end") {
    finishAssistant(); setState("active");
  }
}

function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`; div.textContent = text;
  const stream = document.getElementById("stream");
  stream.appendChild(div); stream.scrollTop = 9e9;
  return div;
}
function addToolLine(t) {
  const div = document.createElement("div");
  div.className = "tool-line"; div.textContent = t;
  document.getElementById("stream").appendChild(div);
}
function finishAssistant() { curAssistant = null; }

// ── 项目导航 ──────────────────────────────────────────────────────────────
let allProjects = [];

async function loadProjectList() {
  try { allProjects = await (await fetch("/api/projects")).json(); }
  catch { allProjects = []; }
  renderProjectList(allProjects);
  renderDashboard();
}

function renderProjectList(projects) {
  const list = document.getElementById("proj-list");
  list.innerHTML = "";
  const q = document.getElementById("proj-search").value.trim().toLowerCase();
  const filtered = q ? projects.filter(p =>
    p.name.toLowerCase().includes(q) ||
    String(p.type || "").toLowerCase().includes(q) ||
    (p.tags || []).some((tag) => String(tag).toLowerCase().includes(q))
  ) : projects;
  const ordered = [...filtered].sort((a, b) =>
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || ""))
  );
  if (!ordered.length) {
    list.innerHTML = `<p style="padding:.75rem;font-size:.82rem;color:var(--fg-dim)">没有项目</p>`;
    return;
  }
  ordered.forEach(p => {
    const item = document.createElement("div");
    item.className = "proj-item"; item.dataset.name = p.name;
    item.innerHTML = `
      <div class="proj-header ${activeProject === p.name ? "active" : ""} ${p.pinned ? "pinned" : ""}">
        <span class="proj-toggle">▶</span>
        <span class="proj-name">${p.pinned ? "★ " : ""}${esc(p.name)}</span>
        <button class="proj-pin" type="button" title="${p.pinned ? "取消置顶" : "置顶项目"}">${p.pinned ? "取消" : "置顶"}</button>
        <button class="proj-tags" type="button" title="编辑标签">标签</button>
        <button class="proj-rename" type="button" title="重命名项目">改名</button>
        <button class="proj-export" type="button" title="导出项目">导出</button>
      </div>
      <div class="proj-children"></div>`;
    item.querySelector(".proj-header").addEventListener("click", (ev) => {
      if (ev.target.closest(".proj-export") || ev.target.closest(".proj-rename") || ev.target.closest(".proj-pin") || ev.target.closest(".proj-tags")) return;
      toggleProject(p.name, item);
    });
    item.querySelector(".proj-export").addEventListener("click", () => exportProjectZip(p.name));
    item.querySelector(".proj-rename").addEventListener("click", () => renameProjectPrompt(p.name));
    item.querySelector(".proj-pin").addEventListener("click", () => toggleProjectPinned(p.name, !p.pinned));
    item.querySelector(".proj-tags").addEventListener("click", () => editProjectTags(p.name, p.tags || []));
    list.appendChild(item);
  });
}

function renderTagChips(tags = []) {
  const rows = Array.isArray(tags) ? tags : [];
  if (!rows.length) return "";
  return `<span class="tag-row">${rows.slice(0, 6).map((tag) => `<span class="tag-chip">#${esc(tag)}</span>`).join("")}</span>`;
}

async function toggleProjectPinned(name, pinned) {
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(name)}/pin`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
    if (!res.ok) throw new Error("置顶失败");
    await loadProjectList();
    await loadDashboard();
    toast(pinned ? "项目已置顶" : "已取消置顶");
  } catch (err) {
    toast(err.message || "置顶失败");
  }
}

async function renameProjectPrompt(oldName) {
  const nextName = window.prompt("新的项目名称", oldName);
  if (!nextName) return;
  const clean = nextName.trim();
  if (!clean || clean === oldName) return;
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(oldName)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: clean }),
    });
    if (res.status === 409) throw new Error("项目名已存在");
    if (!res.ok) throw new Error("重命名失败");
    const entry = await res.json();
    if (activeProject === oldName) activeProject = entry.name;
    if (currentArtifact?.project === oldName) currentArtifact.project = entry.name;
    localStorage.setItem("pi-last-project", entry.name);
    await loadProjectList();
    await loadDashboard();
    openProjectByName(entry.name);
    toast("项目已重命名");
  } catch (err) {
    toast(err.message || "重命名失败");
  }
}

async function editProjectTags(project, tags = []) {
  const next = window.prompt("项目标签，用逗号分隔", (tags || []).join(", "));
  if (next == null) return;
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(project)}/tags`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: next }),
    });
    if (!res.ok) throw new Error("标签更新失败");
    await loadProjectList();
    await loadDashboard();
    refreshOpenProject(project);
    toast("项目标签已更新");
  } catch (err) {
    toast(err.message || "标签更新失败");
  }
}

async function loadDashboard() {
  try {
    const res = await fetch("/api/dashboard");
    dashboardData = res.ok ? await res.json() : null;
  } catch {
    dashboardData = null;
  }
  renderDashboard();
  updateTopContext();
}

async function loadStarters() {
  try {
    const res = await fetch("/api/starters");
    starterTemplates = res.ok ? await res.json() : [];
  } catch {
    starterTemplates = [];
  }
  renderStarters();
}

function renderDashboard() {
  const totals = dashboardData?.workspace?.totals ?? {
    projects: allProjects.length,
    artifacts: 0,
    sessions: 0,
    skills: 0,
  };
  setText("metric-projects", totals.projects ?? 0);
  setText("metric-artifacts", totals.artifacts ?? 0);
  setText("metric-sessions", totals.sessions ?? 0);
  setText("metric-skills", totals.skills ?? 0);

  const healthText = document.getElementById("dashboard-health-text");
  const chips = document.getElementById("status-chips");
  if (chips) chips.innerHTML = "";
  if (dashboardData?.health) {
    const { health, runtime } = dashboardData;
    if (healthText) {
      const warnings = health.checks?.warning ?? 0;
      const errors = health.checks?.error ?? 0;
      healthText.textContent = health.ok ? `就绪 · ${warnings} 个提醒` : `${errors} 个错误 · ${warnings} 个提醒`;
    }
    addStatusChip(health.ok ? "系统就绪" : "需要处理", health.ok ? "ok" : "warn");
    addStatusChip(`SDK ${health.piSdkVersion || "--"}`, "info");
    addStatusChip(health.piCliVersion ? `CLI ${health.piCliVersion}` : "CLI 未检测", health.piCliVersion ? "info" : "warn");
    addStatusChip(runtime?.mobileUrl ? `手机 ${hostLabel(runtime.mobileUrl)}` : "手机入口待检测", "info");
    addStatusChip(`${runtime?.activeSessions?.length ?? 0} 个活跃会话`, "info");
  } else {
    if (healthText) healthText.textContent = "等待数据";
    addStatusChip("正在加载摘要", "info");
  }

  renderDashboardActions(dashboardData?.workspace?.actions || []);
  renderDashboardActivity(dashboardData?.workspace?.activity || []);

  const recent = document.getElementById("recent-projects");
  if (!recent) return;
  recent.innerHTML = "";
  const recentProjects = dashboardData?.workspace?.recentProjects ?? allProjects.slice(0, 6);
  if (!recentProjects.length) {
    recent.innerHTML = `
      <div class="recent-empty">
        <strong>还没有项目</strong>
        <span>先建一个项目，Pi 会自动保存产物、会话和项目技能。</span>
      </div>`;
    return;
  }
  recentProjects.forEach((project) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-card";
    btn.innerHTML = `
      <span class="recent-name">${project.pinned ? "★ " : ""}${esc(project.name)}</span>
      <span class="recent-meta">${project.type || "create"} · ${formatDate(project.lastUpdated)}</span>
      ${renderTagChips(project.tags)}
      <span class="recent-counts">${project.artifactCount ?? 0} 产物 · ${deliverableLabel(project.deliverables)}</span>
      ${renderDeliverableStrip(project.deliverables)}
      <span class="recent-actions"><span data-delivery-project>交付包</span><span data-export-project>导出</span></span>`;
    btn.addEventListener("click", (ev) => {
      const deliveryTarget = ev.target.closest("[data-delivery-project]");
      if (deliveryTarget) {
        downloadDeliveryPackage(project.name);
        return;
      }
      const exportTarget = ev.target.closest("[data-export-project]");
      if (exportTarget) {
        exportProjectZip(project.name);
        return;
      }
      openProjectByName(project.name);
    });
    recent.appendChild(btn);
  });
}

function renderDashboardActivity(activity = []) {
  const wrap = document.getElementById("dashboard-activity");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = Array.isArray(activity) ? activity.slice(0, 10) : [];
  if (!rows.length) {
    wrap.innerHTML = `
      <div class="dashboard-activity-empty">
        <strong>还没有活动</strong>
        <span>保存产物或继续会话后，这里会形成可追踪的工作流。</span>
      </div>`;
    return;
  }
  rows.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `dashboard-activity-item ${item.kind || "artifact"}`;
    btn.innerHTML = `
      <span class="activity-kind">${item.kind === "session" ? "会话" : "产物"}</span>
      <span class="activity-main">
        <strong>${esc(item.title || "")}</strong>
        <small>${esc(item.project || "")} · ${esc(item.subtitle || "")}</small>
      </span>
      <span class="activity-time">${formatDateTime(item.timestamp)}</span>`;
    btn.addEventListener("click", () => openWorkspaceActivity(item));
    wrap.appendChild(btn);
  });
}

function renderDashboardActions(actions = []) {
  const wrap = document.getElementById("dashboard-actions");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = Array.isArray(actions) ? actions.slice(0, 6) : [];
  if (!rows.length) {
    wrap.innerHTML = `
      <div class="dashboard-actions-empty">
        <strong>暂无待办行动</strong>
        <span>创建项目或生成产物后，这里会自动推荐下一步。</span>
      </div>`;
    return;
  }
  rows.forEach((action) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `dashboard-action ${action.tone || "info"}`;
    btn.innerHTML = `
      <span class="dashboard-action-meta">
        <span>${esc(action.project || "")}</span>
        <small>${esc(readinessLabel(action.projectStatus))} 路 ${Number(action.score) || 0}</small>
      </span>
      <strong>${esc(action.title || "下一步")}</strong>
      <span class="dashboard-action-copy">${esc(action.description || "")}</span>`;
    btn.addEventListener("click", () => runWorkspaceAction(action));
    wrap.appendChild(btn);
  });
}

function renderStarters() {
  const grid = document.getElementById("starter-grid");
  if (!grid) return;
  grid.innerHTML = "";
  if (!starterTemplates.length) {
    grid.innerHTML = `<p class="empty-inline">模板加载中…</p>`;
    return;
  }
  starterTemplates.forEach((starter) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "starter-card";
    btn.innerHTML = `
      <span class="starter-mode">${starter.mode === "work" ? "工作" : "创作"}</span>
      <strong>${esc(starter.title)}</strong>
      <span>${esc(starter.description)}</span>`;
    btn.addEventListener("click", () => startFromStarter(starter));
    grid.appendChild(btn);
  });
}

async function startFromStarter(starter) {
  const fallbackName = starter.suggestedProjectName || starter.title || "新项目";
  const name = uniqueProjectName(fallbackName);
  try {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, type: starter.projectType || starter.mode || "create" }),
    }).then(r => { if (!r.ok) throw new Error("创建失败"); return r.json(); });
    mode = starter.mode || "create";
    updateModeButtons();
    await loadProjectList();
    await loadDashboard();
    activeProject = name;
    pendingText = starter.prompt;
    document.getElementById("stream").innerHTML = "";
    addBubble("user", starter.prompt);
    startSession(name, { preserveStream: true });
    saveRecent({ type: "project", name, label: name });
    localStorage.setItem("pi-last-project", name);
    toast(`已创建「${name}」并启动模板`);
  } catch (err) {
    toast(err.message || "模板启动失败");
  }
}

function uniqueProjectName(base) {
  const clean = String(base).trim() || "新项目";
  const used = new Set(allProjects.map((p) => p.name));
  if (!used.has(clean)) return clean;
  const stamp = new Date();
  const suffix = `${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}`;
  let candidate = `${clean}-${suffix}`;
  let i = 2;
  while (used.has(candidate)) candidate = `${clean}-${suffix}-${i++}`;
  return candidate;
}

function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return "入口已生成";
  }
}

function addStatusChip(label, tone) {
  const chips = document.getElementById("status-chips");
  if (!chips) return;
  const chip = document.createElement("span");
  chip.className = `status-chip ${tone || "info"}`;
  chip.textContent = label;
  chips.appendChild(chip);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function formatDate(value) {
  if (!value) return "未更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatDateTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "--";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function typeLabel(type) {
  return ({
    markdown: "Markdown",
    csv: "CSV",
    screenplay: "剧本",
    json: "JSON",
    text: "文本",
  })[type] || type || "产物";
}

function qualityLabel(status) {
  return ({
    ready: "可交付",
    "needs-work": "需打磨",
    error: "需修复",
  })[status] || "待检查";
}

function renderQualityBanner(quality) {
  if (!quality) return "";
  const issues = (quality.issues || []).slice(0, 3).map((issue) =>
    `<li class="${esc(issue.level)}">${esc(issue.message)}</li>`,
  ).join("");
  const canRefine = currentArtifact && quality.status !== "ready";
  const pending = canRefine && pendingArtifactRefines.has(artifactKey(currentArtifact.project, currentArtifact.file));
  return `
    <section class="quality-banner ${esc(quality.status)}">
      <div class="quality-score">
        <strong>${Number(quality.score) || 0}</strong>
        <span>${esc(qualityLabel(quality.status))}</span>
      </div>
      <div class="quality-body">
        <div class="quality-meta">${quality.words ?? 0} 字词 · ${quality.lines ?? 0} 行 · ${quality.headings ?? 0} 标题</div>
        <ul>${issues}</ul>
        ${canRefine ? `<button class="quality-refine ${pending ? "pending" : ""}" type="button" data-quality-refine ${pending ? "disabled" : ""}>${pending ? "等待打磨" : "按问题打磨"}</button>` : ""}
      </div>
    </section>`;
}

function artifactKey(project, file) {
  return `${project || ""}:${file || ""}`;
}

function buildQualityRefinePrompt(project, file, quality) {
  const issueText = (quality?.issues || [])
    .filter((issue) => issue.level !== "ok")
    .map((issue, index) => `${index + 1}. ${issue.message}`)
    .join("\n");
  return `请根据质量检查结果打磨产物 ${file}。\n\n需要处理的问题：\n${issueText || "请整体提升结构、完整度和可交付性。"}\n\n请保留对项目目标有用的信息，补充必要结构和细节，修复格式问题，并保存回同一个项目「${project}」的产物 ${file}。`;
}

function deliverableLabel(deliverables) {
  if (!deliverables?.total) return "未设清单";
  return `${deliverables.done}/${deliverables.total} 交付 · ${deliverables.percent}%`;
}

function renderDeliverableStrip(deliverables) {
  if (!deliverables?.items?.length) return "";
  return `
    <div class="deliverable-strip" title="项目交付进度">
      <span class="deliverable-progress" style="--p:${Number(deliverables.percent) || 0}%"></span>
      <span>${esc(deliverableLabel(deliverables))}</span>
    </div>`;
}

function renderDeliverableChecklist(project, deliverables) {
  if (!deliverables?.items?.length) return "";
  const rows = deliverables.items.map((item) => `
    <div class="deliverable-item ${item.done ? "done" : ""}" data-deliverable-id="${esc(item.id)}">
      <span class="deliverable-mark">${item.done ? "✓" : "·"}</span>
      <span class="deliverable-copy">
        <strong>${esc(item.title)}</strong>
        <small>${esc(item.done && item.matchedFile ? item.matchedFile : item.description)}</small>
      </span>
      ${renderDeliverableAction(project, item)}
    </div>`).join("");
  return `
    <div class="deliverable-panel">
      <div class="proj-section"><span class="proj-section-label">交付清单</span><span class="proj-section-count">${deliverables.done}/${deliverables.total}</span></div>
      ${rows}
    </div>`;
}

function readinessLabel(status) {
  return ({
    empty: "待启动",
    "in-progress": "推进中",
    "needs-work": "需打磨",
    error: "需修复",
    ready: "可交付",
  })[status] || "检查中";
}

function renderReadinessPanel(project, readiness) {
  if (!readiness) return "";
  const actions = (readiness.actions || []).slice(0, 3).map((action) => `
    <button class="next-action ${esc(action.tone || "info")}" type="button"
      data-next-action-id="${esc(action.id)}"
      data-next-action-prompt="${esc(action.prompt || "")}">
      <strong>${esc(action.title)}</strong>
      <span>${esc(action.description || "")}</span>
    </button>`).join("");
  return `
    <div class="readiness-panel ${esc(readiness.status)}">
      <div class="readiness-head">
        <span class="readiness-score">${Number(readiness.score) || 0}</span>
        <span class="readiness-copy">
          <strong>${esc(readinessLabel(readiness.status))}</strong>
          <small>${esc(readiness.summary || "")}</small>
        </span>
      </div>
      <div class="readiness-facts">
        <span>${readiness.artifactCount ?? 0} 产物</span>
        <span>${readiness.deliverables?.done ?? 0}/${readiness.deliverables?.total ?? 0} 交付</span>
        <span>${readiness.readyArtifacts ?? 0} 可交付</span>
      </div>
      <div class="handoff-actions">
        <button class="handoff-btn" type="button" data-handoff-project="${esc(project)}">生成交接摘要</button>
        <button class="handoff-preview-btn" type="button" data-handoff-preview="${esc(project)}">预览摘要</button>
        <button class="handoff-preview-btn" type="button" data-delivery-package="${esc(project)}">下载交付包</button>
      </div>
      ${actions ? `<div class="next-actions">${actions}</div>` : ""}
    </div>`;
}

function renderDeliveryCheckPanel(project, check) {
  if (!check) return "";
  const blockers = check.blockers || [];
  const warnings = check.warnings || [];
  const items = [...blockers, ...warnings].slice(0, 5).map((item, index) => `
    <div class="delivery-check-item ${esc(item.severity || "warning")}">
      <span class="delivery-check-copy">
        <strong>${esc(item.title || "")}</strong>
        <small>${esc(item.detail || "")}</small>
      </span>
      ${item.prompt ? `<button type="button" data-delivery-check-prompt="${esc(item.prompt)}" data-delivery-check-index="${index}">处理</button>` : ""}
    </div>`).join("");
  return `
    <div class="delivery-check-panel ${check.ready ? "ready" : "blocked"}">
      <div class="proj-section">
        <span class="proj-section-label">交付检查</span>
        <span class="proj-section-count">${check.ready ? "可交付" : `${blockers.length} 阻塞`}</span>
      </div>
      <p class="delivery-check-summary">${esc(check.summary || "")}</p>
      ${items ? `<div class="delivery-check-list">${items}</div>` : `<div class="delivery-check-ok">当前没有阻塞项，可以下载交付包。</div>`}
      <button type="button" class="delivery-check-download" data-delivery-package="${esc(project)}">下载交付包</button>
    </div>`;
}

function projectTypeLabel(type) {
  const value = String(type || "").toLowerCase();
  return PROJECT_TYPE_OPTIONS.find((item) => item.value === value)?.label || value || "通用创作";
}

function renderProjectTypeControl(project, readiness) {
  const current = String(readiness?.type || "create").toLowerCase();
  const hasCurrent = PROJECT_TYPE_OPTIONS.some((item) => item.value === current);
  const options = [
    ...PROJECT_TYPE_OPTIONS,
    ...(hasCurrent ? [] : [{ value: current, label: current }]),
  ].map((item) => `
    <option value="${esc(item.value)}" ${item.value === current ? "selected" : ""}>${esc(item.label)}</option>`).join("");
  return `
    <div class="project-type-panel">
      <span class="project-type-copy">
        <strong>项目类型</strong>
        <small>${esc(projectTypeLabel(current))} · 影响交付清单和成熟度建议</small>
      </span>
      <select class="project-type-select" data-project-type-project="${esc(project)}">${options}</select>
    </div>`;
}

function briefSummary(brief) {
  const parts = [brief?.goal, brief?.audience, brief?.acceptance].map((item) => String(item || "").trim()).filter(Boolean);
  return parts.length ? parts.join(" · ") : "补充目标、受众和验收口径后，Pi 会在新会话里自动带上这些上下文";
}

function renderProjectBriefPanel(project, brief) {
  const hasBrief = ["goal", "audience", "background", "constraints", "acceptance"].some((key) => String(brief?.[key] || "").trim());
  return `
    <div class="project-brief-panel ${hasBrief ? "filled" : ""}">
      <span class="project-brief-copy">
        <strong>项目简报</strong>
        <small>${esc(briefSummary(brief))}</small>
      </span>
      <button class="project-brief-edit" type="button" data-project-brief="${esc(project)}">${hasBrief ? "编辑" : "补充"}</button>
    </div>`;
}

function attachProjectBriefHandlers(root, project, brief) {
  root.querySelectorAll("[data-project-brief]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openProjectBriefEditor(project, brief);
    });
  });
}

function renderProjectTagsPanel(project, tags = []) {
  return `
    <div class="project-tags-panel">
      <span class="project-tags-copy">
        <strong>项目标签</strong>
        <small>${tags.length ? tags.map((tag) => `#${tag}`).join(" · ") : "给项目加标签后，可以在项目列表和搜索里快速找到它"}</small>
      </span>
      <button class="project-tags-edit" type="button" data-project-tags="${esc(project)}">编辑</button>
    </div>`;
}

function attachProjectTagsHandlers(root, project, tags = []) {
  root.querySelectorAll("[data-project-tags]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      editProjectTags(project, tags);
    });
  });
}

function attachProjectTypeHandlers(root, project) {
  root.querySelectorAll("[data-project-type-project]").forEach((select) => {
    select.addEventListener("change", async (ev) => {
      ev.stopPropagation();
      await updateProjectType(project, select.value, select);
    });
  });
}

async function updateProjectType(project, type, select) {
  if (!project || !type) return;
  const previous = select?.dataset.previousType || select?.defaultValue || "";
  if (select) select.disabled = true;
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(project)}/type`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "类型更新失败");
    }
    const entry = await res.json();
    if (select) select.dataset.previousType = entry.type;
    await loadProjectList();
    await loadDashboard();
    openProjectByName(project);
    toast(`项目类型已切换为 ${projectTypeLabel(entry.type)}`);
  } catch (err) {
    if (select && previous) select.value = previous;
    toast(err.message || "类型更新失败");
  } finally {
    if (select) select.disabled = false;
  }
}

function openProjectBriefEditor(project, brief = {}) {
  const modal = document.getElementById("project-brief-modal");
  if (!modal) return;
  modal.dataset.project = project;
  document.getElementById("project-brief-meta").textContent = project;
  for (const key of ["goal", "audience", "background", "constraints", "acceptance"]) {
    const field = document.getElementById(`project-brief-${key}`);
    if (field) field.value = brief?.[key] || "";
  }
  modal.classList.remove("hidden");
  setTimeout(() => document.getElementById("project-brief-goal")?.focus(), 30);
}

function closeProjectBriefEditor() {
  document.getElementById("project-brief-modal")?.classList.add("hidden");
}

async function saveProjectBrief() {
  const modal = document.getElementById("project-brief-modal");
  const project = modal?.dataset.project || "";
  if (!project) return;
  const btn = document.getElementById("project-brief-save");
  const brief = {};
  for (const key of ["goal", "audience", "background", "constraints", "acceptance"]) {
    brief[key] = document.getElementById(`project-brief-${key}`)?.value || "";
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(project)}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(brief),
    });
    if (!res.ok) throw new Error("保存简报失败");
    closeProjectBriefEditor();
    await loadProjectList();
    await loadDashboard();
    openProjectByName(project);
    toast("项目简报已保存，新会话会自动带上");
  } catch (err) {
    toast(err.message || "保存简报失败");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function attachNextActionHandlers(root, project) {
  root.querySelectorAll("[data-next-action-prompt]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const prompt = btn.dataset.nextActionPrompt || "";
      if (!prompt) return;
      btn.classList.add("pending");
      btn.disabled = true;
      sendProjectPrompt(project, prompt);
    });
  });
}

function runWorkspaceAction(action) {
  if (!action?.project || !action?.prompt) return;
  activeProject = action.project;
  sessionId = null;
  curAssistant = null;
  pendingText = null;
  document.getElementById("stream").innerHTML = "";
  highlightProject(action.project);
  saveRecent({ type: "project", name: action.project, label: action.project });
  localStorage.setItem("pi-last-project", action.project);
  sendProjectPrompt(action.project, action.prompt);
}

function openWorkspaceActivity(item) {
  if (!item?.project) return;
  activeProject = item.project;
  highlightProject(item.project);
  saveRecent({ type: "project", name: item.project, label: item.project });
  localStorage.setItem("pi-last-project", item.project);
  if (item.kind === "session" && item.sessionId) {
    loadSessionHistory(item.project, item.sessionId);
    return;
  }
  if (item.file) {
    loadPreview(item.project, item.file);
    saveRecent({ type: "artifact", name: `${item.project}/${item.file}`, label: item.file, project: item.project, file: item.file });
    setState("active");
  }
}

function attachHandoffHandlers(root, project) {
  root.querySelectorAll("[data-handoff-project]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await saveProjectHandoff(project, btn);
    });
  });
  root.querySelectorAll("[data-handoff-preview]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await previewProjectHandoff(project, btn);
    });
  });
  root.querySelectorAll("[data-delivery-package]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      downloadDeliveryPackage(project);
    });
  });
}

function attachDeliveryCheckHandlers(root, project) {
  root.querySelectorAll("[data-delivery-check-prompt]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const prompt = btn.dataset.deliveryCheckPrompt || "";
      if (!prompt) return;
      btn.disabled = true;
      btn.textContent = "处理中";
      sendProjectPrompt(project, prompt);
    });
  });
  root.querySelectorAll("[data-delivery-package]").forEach((btn) => {
    if (btn.dataset.deliveryPackageBound) return;
    btn.dataset.deliveryPackageBound = "1";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      downloadDeliveryPackage(project);
    });
  });
}

function deliverableKey(project, itemId) {
  return `${project || ""}:${itemId || ""}`;
}

function clearPendingDeliverables(project) {
  const prefix = `${project || ""}:`;
  [...pendingDeliverables].forEach((key) => {
    if (key.startsWith(prefix)) pendingDeliverables.delete(key);
  });
}

function renderDeliverableAction(project, item) {
  if (item.done) return "";
  const pending = pendingDeliverables.has(deliverableKey(project, item.id));
  return `<button class="deliverable-generate ${pending ? "pending" : ""}" type="button" data-deliverable-id="${esc(item.id)}" data-deliverable-prompt="${esc(item.prompt || "")}" ${pending ? "disabled" : ""}>${pending ? "等待" : "生成"}</button>`;
}

function renderTrashPanel(project, trash) {
  if (!trash?.length) return "";
  const rows = trash.slice(0, 8).map((item) => `
    <div class="trash-item">
      <span class="trash-copy">
        <strong>${esc(item.file)}</strong>
        <small>${esc(formatDateTime(item.trashedAt))} · ${formatBytes(item.size)} · ${esc(item.type || "产物")}</small>
      </span>
      <button class="trash-restore" type="button" data-trash-file="${esc(item.trashedFile)}">恢复</button>
    </div>`).join("");
  return `
    <div class="trash-panel">
      <div class="proj-section"><span class="proj-section-label">回收站</span><span class="proj-section-count">${trash.length}</span></div>
      ${rows}
    </div>`;
}

function attachTrashHandlers(root, project) {
  root.querySelectorAll("[data-trash-file]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await restoreTrashArtifact(project, btn.dataset.trashFile || "", btn);
    });
  });
}

async function restoreTrashArtifact(project, trashedFile, button) {
  if (!project || !trashedFile) return;
  const btn = button;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "恢复中";
  }
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(project)}/trash/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trashedFile }),
    });
    if (res.status === 409) {
      toast("恢复失败：已有同名产物");
      return;
    }
    if (!res.ok) throw new Error("restore failed");
    const data = await res.json();
    await refreshArchive(project);
    await refreshOpenProject(project);
    if (data.artifact?.file) await loadPreview(project, data.artifact.file);
    toast("产物已恢复");
  } catch {
    toast("恢复失败");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "恢复";
    }
  }
}

function openProjectByName(name) {
  const item = [...document.querySelectorAll(".proj-item")].find(el => el.dataset.name === name);
  if (!item) return false;
  item.querySelector(".proj-header").click();
  return true;
}

function highlightProject(name) {
  const item = [...document.querySelectorAll(".proj-item")].find(el => el.dataset.name === name);
  if (!item) return false;
  document.querySelectorAll(".proj-header").forEach(el => el.classList.remove("active"));
  item.querySelector(".proj-header")?.classList.add("active");
  return true;
}

async function refreshOpenProject(name) {
  const item = [...document.querySelectorAll(".proj-item")].find(el => el.dataset.name === name);
  if (!item) return;
  const children = item.querySelector(".proj-children");
  if (!children?.classList.contains("open")) return;
  children.classList.remove("open");
  await toggleProject(name, item);
}

function exportProjectZip(name) {
  if (!name) return;
  location.href = `/api/project/${encodeURIComponent(name)}/export`;
}

async function downloadDeliveryPackage(name) {
  if (!name) return;
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(name)}/delivery-check`);
    if (res.ok) {
      const check = await res.json();
      if (!check.ready) {
        const blockers = (check.blockers || []).slice(0, 4).map((item) => `- ${item.title}`).join("\n");
        const warnings = (check.warnings || []).slice(0, 3).map((item) => `- ${item.title}`).join("\n");
        const message = [
          `项目「${name}」还未达到可交付状态。`,
          `当前状态: ${readinessLabel(check.status)} · ${Number(check.score) || 0}`,
          blockers ? `\n阻塞项:\n${blockers}` : "",
          warnings ? `\n建议项:\n${warnings}` : "",
          "\n仍要下载交付包吗？",
        ].filter(Boolean).join("\n");
        if (!confirm(message)) return;
      }
    }
  } catch {
    if (!confirm("交付前检查失败，仍要下载交付包吗？")) return;
  }
  location.href = `/api/project/${encodeURIComponent(name)}/delivery`;
}

async function previewProjectHandoff(project, button) {
  if (!project) return;
  const btn = button;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "生成中";
  }
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(project)}/handoff`);
    if (!res.ok) throw new Error("handoff failed");
    const data = await res.json();
    const body = document.getElementById("preview-body");
    document.getElementById("preview-title").textContent = data.file || "交接摘要";
    body.dataset.project = data.project || project;
    body.dataset.file = "";
    currentArtifact = null;
    updateArtifactActions();
    body.innerHTML = renderHandoffPreview(data);
    body.querySelector("[data-copy-handoff]")?.addEventListener("click", async () => {
      try {
        await copyText(data.content || "");
        toast("交接摘要已复制");
      } catch {
        toast("复制失败");
      }
    });
    saveRecent({ type: "artifact", name: `${project}/handoff-preview`, label: "交接摘要预览", project });
    toast("交接摘要已生成预览");
  } catch {
    toast("交接摘要生成失败");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "预览摘要";
    }
  }
}

async function saveProjectHandoff(project, button) {
  if (!project) return;
  const btn = button;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "保存中";
  }
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(project)}/handoff`, { method: "POST" });
    if (!res.ok) throw new Error("handoff failed");
    const data = await res.json();
    await refreshArchive(project);
    await refreshOpenProject(project);
    await loadPreview(data.project || project, data.file || "handoff-summary.md");
    toast("交接摘要已保存");
  } catch {
    toast("交接摘要保存失败");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "生成交接摘要";
    }
  }
}

function renderHandoffPreview(data) {
  const content = String(data?.content || "");
  return `
    <section class="handoff-preview">
      <div class="handoff-preview-head">
        <div>
          <span class="eyebrow">交接摘要预览</span>
          <strong>${esc(data?.project || "")}</strong>
        </div>
        <button type="button" class="handoff-copy-btn" data-copy-handoff>复制摘要</button>
      </div>
      ${markdownPreview(content)}
    </section>`;
}

function markdownPreview(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let tableOpen = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };
  const closeTable = () => {
    if (tableOpen) {
      html.push("</tbody></table>");
      tableOpen = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      closeTable();
      continue;
    }
    if (/^\|?\s*-{3,}/.test(trimmed)) continue;
    if (trimmed.startsWith("|")) {
      closeList();
      const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((cell) => esc(cell.trim()));
      if (!tableOpen) {
        html.push("<table><tbody>");
        tableOpen = true;
      }
      html.push(`<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
      continue;
    }
    closeTable();
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${esc(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const bullet = trimmed.match(/^-\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${esc(bullet[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${esc(trimmed)}</p>`);
  }
  closeList();
  closeTable();
  return `<div class="rendered-artifact">${html.join("")}</div>`;
}

async function toggleProject(name, itemEl) {
  const header = itemEl.querySelector(".proj-header");
  const children = itemEl.querySelector(".proj-children");
  const toggle = itemEl.querySelector(".proj-toggle");
  if (children.classList.contains("open")) { children.classList.remove("open"); toggle.textContent = "▶"; return; }
  document.querySelectorAll(".proj-header").forEach(el => el.classList.remove("active"));
  children.classList.add("open"); toggle.textContent = "▼"; header.classList.add("active");
  activeProject = name; setState("loading-project");

  try {
    const [sessions, bible, skills, artifacts, deliverables, readiness, deliveryCheck, trash, brief] = await Promise.all([
      fetch(`/api/projects/${encodeURIComponent(name)}/sessions`).then(r => r.json()).catch(() => []),
      fetch(`/api/projects/${encodeURIComponent(name)}/bible`).then(r => r.json()).catch(() => []),
      fetch(`/api/projects/${encodeURIComponent(name)}/skills`).then(r => r.json()).catch(() => []),
      fetch(`/api/project/${encodeURIComponent(name)}/details`).then(r => r.json()).catch(() => []),
      fetch(`/api/project/${encodeURIComponent(name)}/deliverables`).then(r => r.json()).catch(() => null),
      fetch(`/api/project/${encodeURIComponent(name)}/readiness`).then(r => r.json()).catch(() => null),
      fetch(`/api/project/${encodeURIComponent(name)}/delivery-check`).then(r => r.json()).catch(() => null),
      fetch(`/api/project/${encodeURIComponent(name)}/trash`).then(r => r.json()).catch(() => []),
      fetch(`/api/project/${encodeURIComponent(name)}/brief`).then(r => r.json()).catch(() => ({})),
    ]);
    children.innerHTML = "";
    children.insertAdjacentHTML("beforeend", renderReadinessPanel(name, readiness));
    attachNextActionHandlers(children, name);
    attachHandoffHandlers(children, name);
    children.insertAdjacentHTML("beforeend", renderDeliveryCheckPanel(name, deliveryCheck));
    attachDeliveryCheckHandlers(children, name);
    const projectEntry = allProjects.find((item) => item.name === name) || {};
    children.insertAdjacentHTML("beforeend", renderProjectTagsPanel(name, projectEntry.tags || []));
    attachProjectTagsHandlers(children, name, projectEntry.tags || []);
    children.insertAdjacentHTML("beforeend", renderProjectBriefPanel(name, brief));
    attachProjectBriefHandlers(children, name, brief);
    children.insertAdjacentHTML("beforeend", renderProjectTypeControl(name, readiness));
    attachProjectTypeHandlers(children, name);
    children.insertAdjacentHTML("beforeend", renderDeliverableChecklist(name, deliverables));
    children.querySelectorAll(".deliverable-generate").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const itemId = btn.dataset.deliverableId || "";
        const prompt = btn.dataset.deliverablePrompt || "";
        pendingDeliverables.add(deliverableKey(name, itemId));
        btn.classList.add("pending");
        btn.disabled = true;
        btn.textContent = "等待";
        sendProjectPrompt(name, prompt);
      });
    });

    // Artifacts
    if (artifacts.length) {
      const aSec = document.createElement("div");
      aSec.innerHTML = `<div class="proj-section"><span class="proj-section-label">产物</span><span class="proj-section-count">${artifacts.length}</span></div>`;
      artifacts.forEach(artifact => {
        const file = artifact.file || artifact;
        const el = document.createElement("div");
        el.className = "artifact-item";
        el.innerHTML = `
          <span class="artifact-name">${esc(file)}</span>
          <span class="artifact-meta">${artifact.type ? esc(typeLabel(artifact.type)) : "产物"} · ${formatBytes(artifact.size)} · ${formatDate(artifact.updatedAt)}</span>`;
        el.addEventListener("click", () => {
          activeProject = name;
          loadPreview(name, file);
          saveRecent({ type: "artifact", name: `${name}/${file}`, label: file, project: name, file });
          if (matchMedia("(max-width: 768px)").matches) {
            const scroller = document.querySelector(".three-panel");
            const preview = document.querySelector(".right-panel");
            if (scroller && preview) scroller.scrollTo({ top: preview.offsetTop, behavior: "smooth" });
          }
        });
        aSec.appendChild(el);
      });
      children.appendChild(aSec);
    }
    const manualArtifactBtn = document.createElement("button");
    manualArtifactBtn.type = "button";
    manualArtifactBtn.className = "manual-artifact-btn";
    manualArtifactBtn.textContent = "＋ 新建产物";
    manualArtifactBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openArtifactCreator(name);
    });
    children.appendChild(manualArtifactBtn);
    children.insertAdjacentHTML("beforeend", renderTrashPanel(name, trash));
    attachTrashHandlers(children, name);

    // Sessions
    const sSec = document.createElement("div");
    sSec.innerHTML = `<div class="proj-section"><span class="proj-section-label">💬 会话</span><span class="proj-section-count">${sessions.length}</span></div>`;
    sessions.forEach(s => {
      const el = document.createElement("div"); el.className = "session-item";
      el.textContent = s.label || s.id.slice(0,16);
      el.addEventListener("click", () => loadSessionHistory(name, s.id)); sSec.appendChild(el);
    });
    const newBtn = document.createElement("div"); newBtn.className = "session-item"; newBtn.textContent = "＋ 新建会话"; newBtn.style.color = "var(--accent)";
    newBtn.addEventListener("click", () => startSession(name)); sSec.appendChild(newBtn);
    children.appendChild(sSec);

    // Bible count
    if (bible.length) {
      const bSec = document.createElement("div");
      bSec.innerHTML = `<div class="proj-section"><span class="proj-section-label">🧠 记忆</span><span class="proj-section-count">${bible.length}</span></div>`;
      children.appendChild(bSec);
    }

    // Skills
    if (skills.length) {
      const skSec = document.createElement("div");
      skSec.innerHTML = `<div class="proj-section"><span class="proj-section-label">✦ Skills</span><span class="proj-section-count">${skills.length}</span></div>`;
      skills.forEach(sk => {
        const el = document.createElement("div"); el.className = "skill-item";
        el.innerHTML = `<span class="skill-icon">▷</span>${esc(sk.displayName || sk.name)}`; el.title = sk.description;
        if (sk.valid === false) el.title = `${sk.description || ""}\n旧 skill 名不符合 SDK 规范，doctor 会提示修复`;
        el.addEventListener("click", () => invokeSkill(name, sk.name)); skSec.appendChild(el);
      });
      children.appendChild(skSec);
    }

    if (sessions.length === 0) {
      startSession(name);
    } else {
      const lastSid = localStorage.getItem("pi-last-session");
      const resume = lastSid && sessions.find(s => s.id === lastSid);
      if (resume) loadSessionHistory(name, resume.id);
      else startSession(name);
    }
    saveRecent({ type: "project", name, label: name });
    localStorage.setItem("pi-last-project", name);
  } catch (err) { setState("failed", "加载失败：" + err.message); }
}

function startSession(project, opts = {}) {
  activeProject = project;
  const preserveStream = Boolean(opts.preserveStream);
  if (!preserveStream) document.getElementById("stream").innerHTML = "";
  curAssistant = null; sessionId = null;
  setState("creating-session");
  wsSend({ type: "create", payload: { project, mode, resumeSessionId: opts.resumeSessionId } });
}

function invokeSkill(project, skillName) {
  activeProject = project;
  if (!sessionId) {
    pendingText = `/skill:${skillName}`;
    startSession(project);
  } else {
    addBubble("user", `/skill:${skillName}`);
    wsSend({ type: "prompt", sessionId, payload: { text: `/skill:${skillName}` } });
    setState("streaming");
  }
}

function sendProjectPrompt(project, text, opts = {}) {
  const clean = String(text || "").trim();
  if (!clean) return;
  activeProject = project || activeProject;
  if (!activeProject) {
    toast("请先选择或创建项目");
    setState("no-project");
    return;
  }
  if (opts.showBubble !== false) addBubble("user", clean);
  document.getElementById("input").value = "";
  if (!sessionId) {
    pendingText = clean;
    startSession(activeProject, { preserveStream: true });
    return;
  }
  wsSend({ type: "prompt", sessionId, payload: { text: clean } });
  setState("streaming");
}

// ── 加载历史会话内容 ────────────────────────────────────────────────────────
async function loadSessionHistory(project, id) {
  activeProject = project; sessionId = null;
  localStorage.setItem("pi-last-session", id);
  const stream = document.getElementById("stream");
  stream.innerHTML = ""; curAssistant = null;
  setState("loading-project");
  try {
    const msgs = await (await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`)).json();
    setState("active");
    msgs.forEach(m => addBubble(m.role === "user" ? "user" : "assistant", m.text));
    stream.scrollTop = stream.scrollHeight;
    // 后续发消息时在这个历史会话上继续，恢复真实 Pi session。
    startSession(project, { preserveStream: true, resumeSessionId: id });
  } catch { setState("failed", "加载会话失败"); }
}

// ── 提交 ──────────────────────────────────────────────────────────────────
document.getElementById("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = document.getElementById("input").value.trim();
  if (!text) return;
  sendProjectPrompt(activeProject, text);
});
document.getElementById("input").addEventListener("keydown", ev => {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) document.getElementById("composer").requestSubmit();
});

// ── 模式切换 ──────────────────────────────────────────────────────────────
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode; updateModeButtons();
    if (sessionId) wsSend({ type: "set_mode", sessionId, payload: { mode } });
    toast((mode === "work" ? "工作模式" : "创作模式") + "，下次发送生效");
  });
});
function updateModeButtons() {
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  updateTopContext();
}

// ── 预览 ──────────────────────────────────────────────────────────────────
async function loadPreview(project, file) {
  document.getElementById("preview-title").textContent = file;
  const body = document.getElementById("preview-body");
  body.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div>`;
  body.dataset.project = project; body.dataset.file = file;
  currentArtifact = { project, file };
  updateArtifactActions();
  try {
    const [previewRes, qualityRes] = await Promise.all([
      fetch(`/api/preview?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`),
      fetch(`/api/artifact/quality?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`),
    ]);
    const data = previewRes.ok ? await previewRes.json() : { html: "" };
    const qualityData = qualityRes.ok ? await qualityRes.json() : null;
    body.innerHTML = renderQualityBanner(qualityData?.quality) + (data.html || `<p class="empty-hint">空内容</p>`);
    body.querySelector("[data-quality-refine]")?.addEventListener("click", (ev) => {
      const btn = ev.currentTarget;
      pendingArtifactRefines.add(artifactKey(project, file));
      btn.classList.add("pending");
      btn.disabled = true;
      btn.textContent = "等待打磨";
      sendProjectPrompt(project, buildQualityRefinePrompt(project, file, qualityData?.quality));
    });
  } catch { body.innerHTML = `<p class="error-hint">预览加载失败</p>`; }
}

async function refreshArchive(project) {
  await loadProjectList();
  await loadDashboard();
  if (project) {
    localStorage.setItem("pi-last-project", project);
    activeProject = project;
  }
}

// ── 二维码 ────────────────────────────────────────────────────────────────
document.getElementById("qr-btn").addEventListener("click", async () => {
  const { project, file } = document.getElementById("preview-body").dataset;
  const path = project && file ? `/preview/x?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}` : "/mobile";
  try {
    const data = await (await fetch(`/api/qr?path=${encodeURIComponent(path)}`)).json();
    document.getElementById("qr-img").src = data.dataUrl;
    document.getElementById("qr-target").textContent = data.target;
    document.getElementById("qr-modal").classList.remove("hidden");
  } catch { toast("二维码生成失败"); }
});
document.getElementById("qr-close").addEventListener("click", () => document.getElementById("qr-modal").classList.add("hidden"));
document.getElementById("preview-mobile-btn")?.addEventListener("click", () => document.getElementById("qr-btn").click());
document.getElementById("edit-artifact-btn")?.addEventListener("click", openArtifactEditor);
document.getElementById("history-artifact-btn")?.addEventListener("click", openArtifactHistory);
document.getElementById("copy-artifact-btn")?.addEventListener("click", copyCurrentArtifact);
document.getElementById("download-artifact-btn")?.addEventListener("click", downloadCurrentArtifact);
document.getElementById("raw-artifact-btn")?.addEventListener("click", openCurrentArtifactRaw);
document.getElementById("trash-artifact-btn")?.addEventListener("click", trashCurrentArtifact);
document.getElementById("artifact-editor-close")?.addEventListener("click", closeArtifactEditor);
document.getElementById("artifact-editor-cancel")?.addEventListener("click", closeArtifactEditor);
document.getElementById("artifact-editor-save")?.addEventListener("click", saveArtifactEditor);
document.getElementById("artifact-editor-modal")?.addEventListener("click", (ev) => {
  if (ev.target === document.getElementById("artifact-editor-modal")) closeArtifactEditor();
});
document.getElementById("artifact-history-close")?.addEventListener("click", closeArtifactHistory);
document.getElementById("artifact-history-modal")?.addEventListener("click", (ev) => {
  if (ev.target === document.getElementById("artifact-history-modal")) closeArtifactHistory();
});

function updateArtifactActions() {
  const enabled = Boolean(currentArtifact?.project && currentArtifact?.file);
  ["edit-artifact-btn", "history-artifact-btn", "copy-artifact-btn", "download-artifact-btn", "raw-artifact-btn", "trash-artifact-btn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !enabled;
  });
}

async function openArtifactEditor() {
  if (!currentArtifact) return;
  const { project, file } = currentArtifact;
  const modal = document.getElementById("artifact-editor-modal");
  const title = document.getElementById("artifact-editor-title");
  const fileInput = document.getElementById("artifact-editor-file");
  const text = document.getElementById("artifact-editor-text");
  const meta = document.getElementById("artifact-editor-meta");
  const save = document.getElementById("artifact-editor-save");
  artifactEditorMode = "edit";
  artifactEditorProject = project;
  modal.classList.remove("hidden");
  title.textContent = "编辑产物";
  meta.textContent = `${project} / ${file}`;
  fileInput.classList.add("hidden");
  fileInput.value = file;
  text.value = "加载中...";
  text.disabled = true;
  save.disabled = true;
  try {
    const res = await fetch(`/api/artifact?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error("load failed");
    const data = await res.json();
    text.value = data.content || "";
    text.disabled = false;
    save.disabled = false;
    text.focus();
  } catch {
    text.value = "";
    closeArtifactEditor();
    toast("编辑器加载失败");
  }
}

function openArtifactCreator(project) {
  const modal = document.getElementById("artifact-editor-modal");
  const title = document.getElementById("artifact-editor-title");
  const fileInput = document.getElementById("artifact-editor-file");
  const text = document.getElementById("artifact-editor-text");
  const meta = document.getElementById("artifact-editor-meta");
  const save = document.getElementById("artifact-editor-save");
  artifactEditorMode = "create";
  artifactEditorProject = project;
  modal.classList.remove("hidden");
  title.textContent = "新建产物";
  meta.textContent = project;
  fileInput.classList.remove("hidden");
  fileInput.value = suggestedArtifactName();
  text.value = "# 新产物\n\n## 背景\n\n\n## 内容\n\n\n## 下一步\n\n";
  text.disabled = false;
  save.disabled = false;
  setTimeout(() => fileInput.focus(), 30);
}

function suggestedArtifactName() {
  const stamp = new Date();
  return `artifact-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}.md`;
}

function closeArtifactEditor() {
  document.getElementById("artifact-editor-modal")?.classList.add("hidden");
}

async function saveArtifactEditor() {
  const fileInput = document.getElementById("artifact-editor-file");
  const text = document.getElementById("artifact-editor-text");
  const save = document.getElementById("artifact-editor-save");
  const project = artifactEditorMode === "create" ? artifactEditorProject : currentArtifact?.project;
  const file = artifactEditorMode === "create" ? fileInput.value.trim() : currentArtifact?.file;
  if (!project || !file) {
    toast("请填写项目和文件名");
    return;
  }
  save.disabled = true;
  try {
    const res = await fetch("/api/artifact", {
      method: artifactEditorMode === "create" ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, file, content: text.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || "save failed");
    }
    closeArtifactEditor();
    currentArtifact = { project, file };
    await loadPreview(project, file);
    await refreshArchive(project);
    await refreshOpenProject(project);
    toast(artifactEditorMode === "create" ? "产物已创建" : "产物已保存");
  } catch (err) {
    toast((err instanceof Error && err.message.includes("already exists")) ? "文件已存在" : "保存失败");
  } finally {
    save.disabled = false;
  }
}

async function openArtifactHistory() {
  if (!currentArtifact) return;
  const { project, file } = currentArtifact;
  const modal = document.getElementById("artifact-history-modal");
  const meta = document.getElementById("artifact-history-meta");
  const list = document.getElementById("artifact-history-list");
  modal.classList.remove("hidden");
  meta.textContent = `${project} / ${file}`;
  list.innerHTML = `<p class="empty-inline">加载历史中...</p>`;
  try {
    const res = await fetch(`/api/artifact/history?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error("history failed");
    const versions = await res.json();
    renderArtifactHistory(project, file, versions, list);
  } catch {
    list.innerHTML = `<p class="error-hint">历史加载失败</p>`;
  }
}

function closeArtifactHistory() {
  document.getElementById("artifact-history-modal")?.classList.add("hidden");
}

function renderArtifactHistory(project, file, versions, list) {
  if (!versions.length) {
    list.innerHTML = `<p class="empty-inline">还没有历史版本。编辑或重新生成后会自动保留旧版。</p>`;
    return;
  }
  list.innerHTML = "";
  versions.forEach((version) => {
    const row = document.createElement("div");
    row.className = "artifact-history-row";
    row.innerHTML = `
      <div class="artifact-history-main">
        <strong>${esc(formatDateTime(version.createdAt))}</strong>
        <span>${formatBytes(version.size)} · ${esc(version.id)}</span>
      </div>
      <div class="artifact-history-actions">
        <button type="button" class="ghost-btn" data-action="view">查看</button>
        <button type="button" class="ghost-btn" data-action="restore">恢复</button>
      </div>
      <pre class="artifact-history-preview hidden"></pre>`;
    const preview = row.querySelector(".artifact-history-preview");
    row.querySelector('[data-action="view"]').addEventListener("click", async () => {
      if (!preview.classList.contains("hidden")) {
        preview.classList.add("hidden");
        return;
      }
      preview.textContent = "加载中...";
      preview.classList.remove("hidden");
      try {
        const data = await (await fetch(`/api/artifact/history/content?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}&version=${encodeURIComponent(version.id)}`)).json();
        preview.textContent = data.content || "";
      } catch {
        preview.textContent = "版本内容加载失败";
      }
    });
    row.querySelector('[data-action="restore"]').addEventListener("click", async () => {
      try {
        const res = await fetch("/api/artifact/history/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, file, version: version.id }),
        });
        if (!res.ok) throw new Error("restore failed");
        closeArtifactHistory();
        await loadPreview(project, file);
        await refreshArchive(project);
        toast("已恢复历史版本");
      } catch {
        toast("恢复失败");
      }
    });
    list.appendChild(row);
  });
}

async function copyCurrentArtifact() {
  if (!currentArtifact) return;
  try {
    const { project, file } = currentArtifact;
    const data = await (await fetch(`/api/artifact?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`)).json();
    await copyText(data.content || "");
    toast("产物原文已复制");
  } catch {
    toast("复制失败");
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function downloadCurrentArtifact() {
  if (!currentArtifact) return;
  const { project, file } = currentArtifact;
  location.href = `/api/download?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`;
}

function openCurrentArtifactRaw() {
  if (!currentArtifact) return;
  const { project, file } = currentArtifact;
  window.open(`/api/artifact?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`, "_blank", "noopener");
}

async function trashCurrentArtifact() {
  if (!currentArtifact) return;
  const { project, file } = currentArtifact;
  const ok = window.confirm(`移除产物「${file}」？文件会移入项目回收站，并保留历史版本。`);
  if (!ok) return;
  const btn = document.getElementById("trash-artifact-btn");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/artifact", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, file }),
    });
    if (!res.ok) throw new Error("trash failed");
    currentArtifact = null;
    updateArtifactActions();
    document.getElementById("preview-title").textContent = "活页本";
    document.getElementById("preview-body").innerHTML = `
      <div class="preview-empty">
        <div class="preview-empty-icon">▦</div>
        <div class="preview-empty-title">产物已移除</div>
        <div class="preview-empty-sub">它已进入项目回收站，历史版本仍可用于追溯。</div>
      </div>`;
    await refreshArchive(project);
    await refreshOpenProject(project);
    toast("产物已移入回收站");
  } catch {
    toast("移除失败");
    updateArtifactActions();
  }
}

// ── 分叉树 ────────────────────────────────────────────────────────────────
document.getElementById("fork-btn").addEventListener("click", () => {
  document.getElementById("fork-drawer").classList.remove("hidden");
  if (sessionId) wsSend({ type: "fork_points", sessionId });
});
document.getElementById("fork-close").addEventListener("click", () => document.getElementById("fork-drawer").classList.add("hidden"));

function rowsFromPoints(points = [], leafId = null) {
  return points.map((p, i) => ({
    id: p.entryId,
    depth: i,
    kind: "user",
    role: "user",
    text: p.text,
    branchable: true,
    current: p.entryId === leafId,
    onCurrentPath: p.entryId === leafId,
    childCount: 0,
  }));
}

function renderForkPoints(data, legacyLeafId) {
  const payload = Array.isArray(data) ? { points: data, leafId: legacyLeafId } : data;
  const rows = payload.rows?.length ? payload.rows : rowsFromPoints(payload.points, payload.leafId);
  const body = document.getElementById("fork-body");
  if (!rows?.length) { body.innerHTML = `<p class="empty-hint">没有可分叉的消息</p>`; return; }
  body.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "fork-summary";
  const branchableCount = payload.branchableCount ?? (payload.points?.length ?? rows.filter(r => r.branchable).length);
  summary.textContent = `${rows.length} 个节点 · ${branchableCount} 个可分叉点`;
  body.appendChild(summary);

  rows.forEach((row) => {
    const node = document.createElement(row.branchable ? "button" : "div");
    node.className = [
      "fork-node",
      `fork-${row.kind || row.role || "entry"}`,
      row.current ? "current" : "",
      row.onCurrentPath ? "on-path" : "",
      row.branchable ? "branchable" : "",
    ].filter(Boolean).join(" ");
    node.style.setProperty("--depth", String(Math.min(row.depth ?? 0, 8)));
    if (row.branchable) {
      node.type = "button";
      node.addEventListener("click", () => {
        wsSend({ type: "fork", sessionId, payload: { entryId: row.id } });
        document.getElementById("fork-drawer").classList.add("hidden");
      });
    }

    const rail = document.createElement("span");
    rail.className = "fork-rail";
    rail.textContent = row.childCount > 1 ? "┬" : row.onCurrentPath ? "│" : "·";

    const content = document.createElement("span");
    content.className = "fork-content";

    const meta = document.createElement("span");
    meta.className = "fork-meta";
    meta.textContent = row.kind === "user" ? "用户" : row.kind === "assistant" ? "Pi" : row.kind === "summary" ? "摘要" : "节点";

    const text = document.createElement("span");
    text.className = "fork-text";
    text.textContent = row.text || "(空消息)";

    content.appendChild(meta);
    content.appendChild(text);
    if (row.label) {
      const label = document.createElement("span");
      label.className = "fork-label";
      label.textContent = row.label;
      content.appendChild(label);
    }

    if (row.current) {
      const current = document.createElement("span");
      current.className = "fork-here";
      current.textContent = "当前";
      content.appendChild(current);
    } else if (row.branchable) {
      const action = document.createElement("span");
      action.className = "fork-action";
      action.textContent = "从这里分叉";
      content.appendChild(action);
    }

    node.appendChild(rail);
    node.appendChild(content);
    body.appendChild(node);
  });
}

// ── 新建项目 ──────────────────────────────────────────────────────────────
document.getElementById("new-proj-btn").addEventListener("click", () => {
  document.getElementById("new-proj-modal").classList.remove("hidden");
  document.getElementById("new-proj-name").value = "";
  setTimeout(() => document.getElementById("new-proj-name").focus(), 30);
});
document.getElementById("new-proj-cancel").addEventListener("click", () => document.getElementById("new-proj-modal").classList.add("hidden"));
document.getElementById("new-proj-confirm").addEventListener("click", async () => {
  const name = document.getElementById("new-proj-name").value.trim();
  if (!name) return;
  document.getElementById("new-proj-modal").classList.add("hidden");
  try {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, type: "create" }),
    }).then(r => { if (!r.ok) throw new Error("创建失败"); return r.json(); });
    await loadProjectList();
    await loadDashboard();
    openProjectByName(name);
    toast(`项目「${name}」已创建`);
  } catch (err) {
    toast(err.message || "创建失败");
  }
});
document.getElementById("new-proj-name").addEventListener("keydown", ev => {
  if (ev.key === "Enter") document.getElementById("new-proj-confirm").click();
  if (ev.key === "Escape") document.getElementById("new-proj-cancel").click();
});
document.getElementById("project-brief-close")?.addEventListener("click", closeProjectBriefEditor);
document.getElementById("project-brief-cancel")?.addEventListener("click", closeProjectBriefEditor);
document.getElementById("project-brief-save")?.addEventListener("click", saveProjectBrief);
document.getElementById("dashboard-new-project")?.addEventListener("click", () => document.getElementById("new-proj-btn").click());
document.getElementById("dashboard-open-palette")?.addEventListener("click", openPalette);
document.getElementById("import-proj-btn")?.addEventListener("click", () => document.getElementById("import-proj-file").click());
document.getElementById("import-proj-file")?.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const zipBase64 = await fileToBase64(file);
    const result = await fetch("/api/projects/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ zipBase64 }),
    }).then(r => { if (!r.ok) throw new Error("导入失败"); return r.json(); });
    await loadProjectList();
    await loadDashboard();
    openProjectByName(result.project.name);
    toast(`已导入「${result.project.name}」`);
  } catch (err) {
    toast(err.message || "导入失败");
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ── 搜索过滤 ──────────────────────────────────────────────────────────────
document.getElementById("proj-search").addEventListener("input", () => renderProjectList(allProjects));

// ── 重试 ──────────────────────────────────────────────────────────────────
document.getElementById("retry-btn").addEventListener("click", () => { reconnectAttempts = 0; setState("no-project"); connect(); });

// ── Command Palette ───────────────────────────────────────────────────────
function saveRecent(item) {
  let r = JSON.parse(localStorage.getItem("pi-recents") || "[]");
  r = r.filter(x => !(x.type === item.type && x.name === item.name));
  r.unshift(item); localStorage.setItem("pi-recents", JSON.stringify(r.slice(0, 20)));
}
function getRecents() { return JSON.parse(localStorage.getItem("pi-recents") || "[]"); }

let palFocus = -1, paletteTimer = null, paletteSeq = 0;
function openPalette() {
  document.getElementById("palette").classList.remove("hidden");
  document.getElementById("palette-input").value = ""; palFocus = -1;
  renderPaletteResults(""); setTimeout(() => document.getElementById("palette-input").focus(), 30);
}
function closePalette() { document.getElementById("palette").classList.add("hidden"); }

async function renderPaletteResults(q) {
  const results = document.getElementById("palette-results");
  results.innerHTML = ""; palFocus = -1;
  const seq = ++paletteSeq;
  if (!q) {
    const recents = getRecents();
    if (!recents.length) { results.innerHTML = `<p style="padding:.75rem 1rem;font-size:.82rem;color:var(--fg-dim)">开始输入搜索项目</p>`; return; }
    results.innerHTML = `<div class="palette-section-head">最近访问</div>`;
    recents.slice(0, 5).forEach(r => addPaletteItem(results, r.type === "project" ? "📂" : "💬", r.label, r.type, r));
    return;
  }
  results.innerHTML = `<p style="padding:.75rem 1rem;font-size:.82rem;color:var(--fg-dim)">搜索中…</p>`;
  const lq = q.toLowerCase();
  const localProjects = allProjects
    .filter(p =>
      p.name.toLowerCase().includes(lq) ||
      String(p.type || "").toLowerCase().includes(lq) ||
      (p.tags || []).some((tag) => String(tag).toLowerCase().includes(lq))
    )
    .map(p => ({ type: "project", project: p.name, title: p.name, subtitle: p.type || "project" }));
  let remote = [];
  try {
    remote = await (await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=12`)).json();
  } catch {
    remote = [];
  }
  if (seq !== paletteSeq) return;
  const seen = new Set();
  const merged = [...localProjects, ...remote].filter((item) => {
    const key = `${item.type}:${item.project}:${item.file || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  results.innerHTML = "";
  if (!merged.length) {
    results.innerHTML = `<p style="padding:.75rem 1rem;font-size:.82rem;color:var(--fg-dim)">没有匹配结果</p>`;
    return;
  }
  results.innerHTML = `<div class="palette-section-head">搜索结果</div>`;
  merged.forEach((item) => {
    addPaletteItem(
      results,
      item.type === "project" ? "📂" : "📄",
      item.title || item.file || item.project,
      item.type,
      item,
      item.snippet || item.subtitle,
    );
  });
}
function addPaletteItem(container, icon, label, type, data, detail = "") {
  const el = document.createElement("div"); el.className = "palette-item";
  el.innerHTML = `
    <span class="palette-item-icon">${icon}</span>
    <span class="palette-item-main">
      <span class="palette-item-label">${esc(label)}</span>
      ${detail ? `<span class="palette-item-detail">${esc(detail)}</span>` : ""}
    </span>
    <span class="palette-item-meta">${type === "artifact" ? "产物" : "项目"}</span>`;
  el.addEventListener("click", () => {
    closePalette();
    if (type === "project") {
      openProjectByName(data.name || data.project);
    } else if (type === "artifact") {
      loadPreview(data.project, data.file);
    }
  });
  container.appendChild(el);
}
document.getElementById("palette-input").addEventListener("input", ev => {
  const q = ev.target.value;
  if (paletteTimer) clearTimeout(paletteTimer);
  paletteTimer = setTimeout(() => renderPaletteResults(q), 160);
});
document.getElementById("palette-input").addEventListener("keydown", ev => {
  const items = document.getElementById("palette-results").querySelectorAll(".palette-item");
  if (ev.key === "ArrowDown") { palFocus = Math.min(palFocus+1, items.length-1); items.forEach((el,i) => el.classList.toggle("focused", i===palFocus)); ev.preventDefault(); }
  else if (ev.key === "ArrowUp") { palFocus = Math.max(palFocus-1, 0); items.forEach((el,i) => el.classList.toggle("focused", i===palFocus)); ev.preventDefault(); }
  else if (ev.key === "Enter" && palFocus >= 0) items[palFocus]?.click();
  else if (ev.key === "Escape") closePalette();
});
document.getElementById("palette").addEventListener("click", ev => { if (ev.target === document.getElementById("palette")) closePalette(); });
document.getElementById("palette-btn").addEventListener("click", openPalette);
document.addEventListener("keydown", ev => { if ((ev.metaKey||ev.ctrlKey) && ev.key === "k") { ev.preventDefault(); openPalette(); } });

// ── 工具函数 ──────────────────────────────────────────────────────────────
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
let toastTimer = null;
function toast(text) {
  const t = document.getElementById("toast"); t.textContent = text; t.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
}

// ── 启动 ──────────────────────────────────────────────────────────────────
setState("no-project");

// 等 WS 就绪 + 项目列表加载后，恢复上次打开的项目
const _wsReady = new Promise(res => {
  connect();
  const _check = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) { clearInterval(_check); res(); }
  }, 50);
});

Promise.all([_wsReady, loadProjectList(), loadStarters()]).then(() => {
  loadDashboard();
  const last = localStorage.getItem("pi-last-project");
  if (!last) return;
  openProjectByName(last);
});
