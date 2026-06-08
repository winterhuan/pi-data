// mobile.js — 手机完整操控版
//
// 三个面板:对话(流式)、档案室(项目+产物)、预览(渲染)
// 模式切换、WebSocket 自动重连,与桌面端共享同一 server。

const $ = (s) => document.querySelector(s);
const stream = $("#stream");
const input = $("#input");
const conn = $("#conn");

let ws = null, sessionId = null, cur = null, reconnectTimer = null;
let activeProject = null, mode = "create", pendingText = null, projects = [];
let dashboardData = null;
let starterTemplates = [];
let currentArtifact = null;
let archiveProjects = [];
let mobileEditorMode = "edit";
let mobileEditorProject = null;
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

// ── WebSocket ──
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    conn.classList.add("ok");
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  ws.onclose = () => { conn.classList.remove("ok"); reconnectTimer = setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else toast("未连接,重连中…");
}

function handle(msg) {
  if (msg.kind === "created") {
    sessionId = msg.sessionId;
    if (msg.project) setActiveProject(msg.project, false);
    if (msg.mode) { mode = msg.mode; updateModeButtons(); }
    localStorage.setItem("pi-mobile-last-session", sessionId);
    if (pendingText) {
      const text = pendingText; pendingText = null;
      sendMsg({ type: "prompt", sessionId, payload: { text } });
    }
    return;
  }
  if (msg.kind === "error") { toast("出错: " + msg.message); cur = null; return; }
  if (msg.kind === "fork_points") { renderMobileForkPoints(msg); return; }
  if (msg.kind === "forked") {
    renderMobileForkPoints(msg);
    stream.innerHTML = "";
    cur = null;
    toast("已分叉，从选中节点继续");
    return;
  }
  if (msg.kind === "mode_set") return;
  if (msg.kind === "agent_event") {
    const e = msg.event;
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      if (!cur) cur = addBubble("assistant", "");
      cur.textContent += e.assistantMessageEvent.delta;
      stream.scrollTop = stream.scrollHeight;
    } else if (e.type === "tool_execution_end" && e.toolName === "save_artifact") {
      const { project, file } = e.result?.details ?? {};
      if (project && file) {
        clearPendingDeliverables(project);
        pendingArtifactRefines.delete(artifactKey(project, file));
        toast(`已保存 ${file}`);
        setActiveProject(project, false);
        loadProjects();
        loadPreview(project, file);
        refreshMobileProjectView(project);
      }
    } else if (e.type === "tool_execution_end" && e.toolName === "save_bible") {
      const { project } = e.result?.details ?? {};
      if (project) { setActiveProject(project, false); loadProjects(); toast("创作设定已保存"); }
    } else if (e.type === "agent_end") { cur = null; }
  }
}

function addBubble(role, text) {
  clearMobileEmpty();
  const d = document.createElement("div");
  d.className = `bubble ${role}`;
  d.textContent = text;
  stream.appendChild(d);
  stream.scrollTop = stream.scrollHeight;
  return d;
}

// ── 对话提交 ──
$("#composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  sendProjectPrompt(activeProject, text);
});

function sendProjectPrompt(project, text, opts = {}) {
  const clean = String(text || "").trim();
  if (!clean) return;
  activeProject = project || activeProject;
  if (!activeProject) { toast("先选择或创建项目"); return; }
  if (opts.showBubble !== false) addBubble("user", clean);
  if (!sessionId) {
    pendingText = clean;
    createSession(activeProject);
  } else {
    sendMsg({ type: "prompt", sessionId, payload: { text: clean } });
  }
  input.value = "";
}

function createSession(project, resumeSessionId) {
  sendMsg({ type: "create", payload: { project, mode, resumeSessionId } });
}

// ── 模式切换 ──
document.querySelectorAll(".m-mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode;
    updateModeButtons();
    if (sessionId) sendMsg({ type: "set_mode", sessionId, payload: { mode } });
    toast((mode === "work" ? "工作模式" : "创作模式") + "，下次发送生效");
  });
});

function updateModeButtons() {
  document.querySelectorAll(".m-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}

$("#mobile-fork-btn")?.addEventListener("click", () => {
  $("#mobile-fork-drawer")?.classList.remove("hidden");
  if (!sessionId) {
    $("#mobile-fork-body").innerHTML = `<p class="empty-hint">先选择项目并发送一条消息。</p>`;
    return;
  }
  $("#mobile-fork-body").innerHTML = `<div class="spinner"></div>`;
  sendMsg({ type: "fork_points", sessionId });
});
$("#mobile-fork-close")?.addEventListener("click", () => $("#mobile-fork-drawer")?.classList.add("hidden"));

function mobileRowsFromPoints(points = [], leafId = null) {
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

function renderMobileForkPoints(data, legacyLeafId) {
  const payload = Array.isArray(data) ? { points: data, leafId: legacyLeafId } : data;
  const rows = payload.rows?.length ? payload.rows : mobileRowsFromPoints(payload.points, payload.leafId);
  const body = $("#mobile-fork-body");
  if (!body) return;
  if (!rows?.length) {
    body.innerHTML = `<p class="empty-hint">没有可分叉的消息</p>`;
    return;
  }
  body.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "fork-summary";
  const branchableCount = payload.branchableCount ?? (payload.points?.length ?? rows.filter((r) => r.branchable).length);
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
        sendMsg({ type: "fork", sessionId, payload: { entryId: row.id } });
        $("#mobile-fork-drawer")?.classList.add("hidden");
        activateChatTab();
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

// ── 项目选择 ──
async function loadProjects() {
  try {
    projects = await (await fetch("/api/projects")).json();
  } catch {
    projects = [];
  }
  renderProjectSelect();
  renderMobileSnapshot();
  const last = localStorage.getItem("pi-mobile-last-project");
  if (!activeProject && last && projects.some((p) => p.name === last)) setActiveProject(last, false);
}

async function loadDashboard() {
  try {
    const res = await fetch("/api/dashboard");
    dashboardData = res.ok ? await res.json() : null;
  } catch {
    dashboardData = null;
  }
  renderMobileSnapshot();
}

async function loadStarters() {
  try {
    const res = await fetch("/api/starters");
    starterTemplates = res.ok ? await res.json() : [];
  } catch {
    starterTemplates = [];
  }
  renderMobileStarters();
}

function renderMobileStarters() {
  const wrap = $("#mobile-starters");
  if (!wrap) return;
  wrap.innerHTML = "";
  starterTemplates.forEach((starter) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "m-starter";
    btn.innerHTML = `<strong>${escapeHtml(starter.title)}</strong><span>${escapeHtml(starter.mode === "work" ? "工作流" : "创作流")}</span>`;
    btn.addEventListener("click", () => startFromStarter(starter));
    wrap.appendChild(btn);
  });
}

function renderMobileSnapshot() {
  const totals = dashboardData?.workspace?.totals ?? { projects: projects.length, artifacts: 0 };
  setText("m-project-count", totals.projects ?? projects.length);
  setText("m-artifact-count", totals.artifacts ?? 0);
  const health = dashboardData?.health;
  const card = $("#m-health-card");
  if (health) {
    setText("m-health-state", health.ok ? "OK" : "提醒");
    card?.classList.toggle("ok", health.ok);
    card?.classList.toggle("warn", !health.ok);
  } else {
    setText("m-health-state", "--");
    card?.classList.remove("ok", "warn");
  }
  renderMobileNextActions();
  renderMobileActivity();
}

function renderMobileNextActions() {
  const wrap = $("#mobile-next-actions");
  if (!wrap) return;
  wrap.innerHTML = "";
  const actions = Array.isArray(dashboardData?.workspace?.actions)
    ? dashboardData.workspace.actions.slice(0, 3)
    : [];
  wrap.classList.toggle("has-actions", actions.length > 0);
  actions.forEach((action) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `mobile-next-action ${action.tone || "info"}`;
    btn.innerHTML = `
      <small>${escapeHtml(action.project || "")}</small>
      <strong>${escapeHtml(action.title || "下一步")}</strong>
      <span>${escapeHtml(action.description || "")}</span>`;
    btn.addEventListener("click", () => runMobileWorkspaceAction(action));
    wrap.appendChild(btn);
  });
}

function renderMobileActivity() {
  const wrap = $("#mobile-activity");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = Array.isArray(dashboardData?.workspace?.activity)
    ? dashboardData.workspace.activity.slice(0, 5)
    : [];
  wrap.classList.toggle("has-activity", rows.length > 0);
  rows.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `mobile-activity-item ${item.kind || "artifact"}`;
    btn.innerHTML = `
      <small>${escapeHtml(item.kind === "session" ? "会话" : "产物")} · ${escapeHtml(item.project || "")}</small>
      <strong>${escapeHtml(item.title || "")}</strong>
      <span>${escapeHtml(item.subtitle || "")}</span>`;
    btn.addEventListener("click", () => openMobileWorkspaceActivity(item));
    wrap.appendChild(btn);
  });
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function renderProjectSelect() {
  const sel = $("#project-select");
  sel.innerHTML = `<option value="">选择项目</option>`;
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.name; opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = activeProject || "";
}

function setActiveProject(name, resetSession = true) {
  activeProject = name || null;
  if (activeProject) localStorage.setItem("pi-mobile-last-project", activeProject);
  if (resetSession) {
    sessionId = null;
    cur = null;
    stream.innerHTML = "";
    if (!activeProject) showMobileEmpty();
  }
  renderProjectSelect();
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

$("#project-select").addEventListener("change", (ev) => setActiveProject(ev.target.value || null));
$("#project-new").addEventListener("click", async () => {
  const name = prompt("项目名称");
  if (!name?.trim()) return;
  try {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), type: "create" }),
    }).then((r) => { if (!r.ok) throw new Error("创建失败"); return r.json(); });
    await loadProjects();
    setActiveProject(name.trim());
    toast("项目已创建");
  } catch (err) {
    toast(err.message || "创建失败");
  }
});

async function startFromStarter(starter) {
  const name = uniqueProjectName(starter.suggestedProjectName || starter.title || "新项目");
  try {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, type: starter.projectType || starter.mode || "create" }),
    }).then((r) => { if (!r.ok) throw new Error("创建失败"); return r.json(); });
    mode = starter.mode || "create";
    updateModeButtons();
    await loadProjects();
    await loadDashboard();
    setActiveProject(name);
    addBubble("user", starter.prompt);
    pendingText = starter.prompt;
    createSession(name);
    toast(`已启动 ${starter.title}`);
  } catch (err) {
    toast(err.message || "模板启动失败");
  }
}

function uniqueProjectName(base) {
  const clean = String(base).trim() || "新项目";
  const used = new Set(projects.map((p) => p.name));
  if (!used.has(clean)) return clean;
  const stamp = new Date();
  const suffix = `${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}`;
  let candidate = `${clean}-${suffix}`;
  let i = 2;
  while (used.has(candidate)) candidate = `${clean}-${suffix}-${i++}`;
  return candidate;
}

// ── 标签页切换 ──
document.querySelectorAll(".m-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".m-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".m-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    const panel = document.getElementById("tab-" + tab.dataset.tab);
    panel.classList.add("active");
    if (tab.dataset.tab === "archive") loadArchive();
  });
});

stream.addEventListener("click", (ev) => {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === "mobile-empty-new") {
    $("#project-new").click();
  } else if (target.id === "mobile-empty-archive") {
    document.querySelector('[data-tab="archive"]').click();
  }
});

// ── 档案室 ──
async function loadArchive() {
  const body = $("#archive-body");
  body.innerHTML = `<div class="spinner"></div>`;
  try {
    if (!dashboardData) await loadDashboard();
    archiveProjects = dashboardData?.workspace?.projects ?? await (await fetch("/api/projects")).json();
    renderArchiveProjects();
  } catch { body.innerHTML = `<p class="error-hint">加载失败</p>`; }
}

function renderArchiveProjects() {
  const body = $("#archive-body");
  const q = ($("#archive-search")?.value || "").trim().toLowerCase();
  const filtered = q ? archiveProjects.filter((p) =>
    p.name.toLowerCase().includes(q) ||
    String(p.type || "").toLowerCase().includes(q) ||
    (p.tags || []).some((tag) => String(tag).toLowerCase().includes(q))
  ) : archiveProjects;
  if (!filtered.length) {
    body.innerHTML = `<p class="empty-hint">${archiveProjects.length ? "没有匹配项目" : "还没有项目"}</p>`;
    return;
  }
  body.innerHTML = "";
  for (const p of filtered) {
    const card = document.createElement("div");
    card.className = `proj-card ${p.pinned ? "pinned" : ""}`;
    card.innerHTML = `
      <strong>${p.pinned ? "★ " : ""}${escapeHtml(p.name)}</strong>
      <span class="proj-meta">${escapeHtml(p.type)} · ${p.lastUpdated.slice(0,10)}</span>
      ${renderMobileTagChips(p.tags)}
      ${renderDeliverableStrip(p.deliverables)}
      <button class="mobile-pin" type="button">${p.pinned ? "取消置顶" : "置顶"}</button>
      <button class="mobile-rename" type="button">改名</button>
      <button class="mobile-tags" type="button">标签</button>
      <button class="mobile-delivery" type="button">交付包</button>
      <button class="mobile-export" type="button">导出项目</button>`;
    card.addEventListener("click", (ev) => {
      if (ev.target.closest(".mobile-pin")) {
        toggleMobileProjectPinned(p.name, !p.pinned);
        return;
      }
      if (ev.target.closest(".mobile-rename")) {
        renameMobileProject(p.name);
        return;
      }
      if (ev.target.closest(".mobile-tags")) {
        editMobileProjectTags(p.name, p.tags || []);
        return;
      }
      if (ev.target.closest(".mobile-export")) {
        exportProjectZip(p.name);
        return;
      }
      if (ev.target.closest(".mobile-delivery")) {
        downloadDeliveryPackage(p.name);
        return;
      }
      setActiveProject(p.name);
      loadProject(p.name);
    });
    body.appendChild(card);
  }
}

function renderMobileTagChips(tags = []) {
  const rows = Array.isArray(tags) ? tags : [];
  if (!rows.length) return "";
  return `<span class="mobile-tag-row">${rows.slice(0, 6).map((tag) => `<span class="mobile-tag-chip">#${escapeHtml(tag)}</span>`).join("")}</span>`;
}

async function toggleMobileProjectPinned(name, pinned) {
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(name)}/pin`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
    if (!res.ok) throw new Error("置顶失败");
    await loadProjects();
    await loadDashboard();
    await loadArchive();
    toast(pinned ? "项目已置顶" : "已取消置顶");
  } catch (err) {
    toast(err.message || "置顶失败");
  }
}

async function renameMobileProject(oldName) {
  const nextName = prompt("新的项目名称", oldName);
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
    if (activeProject === oldName) setActiveProject(entry.name, false);
    if (currentArtifact?.project === oldName) currentArtifact.project = entry.name;
    await loadProjects();
    await loadDashboard();
    await loadArchive();
    setActiveProject(entry.name, false);
    toast("项目已重命名");
  } catch (err) {
    toast(err.message || "重命名失败");
  }
}

async function editMobileProjectTags(project, tags = []) {
  const next = prompt("项目标签，用逗号分隔", (tags || []).join(", "));
  if (next == null) return;
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(project)}/tags`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: next }),
    });
    if (!res.ok) throw new Error("标签更新失败");
    await loadProjects();
    await loadDashboard();
    await loadArchive();
    toast("项目标签已更新");
  } catch (err) {
    toast(err.message || "标签更新失败");
  }
}

$("#archive-search")?.addEventListener("input", renderArchiveProjects);
$("#mobile-import-btn")?.addEventListener("click", () => $("#mobile-import-file").click());
$("#mobile-import-file")?.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const zipBase64 = await fileToBase64(file);
    const result = await fetch("/api/projects/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ zipBase64 }),
    }).then((r) => { if (!r.ok) throw new Error("导入失败"); return r.json(); });
    await loadProjects();
    await loadArchive();
    setActiveProject(result.project.name);
    toast(`已导入 ${result.project.name}`);
  } catch (err) {
    toast(err.message || "导入失败");
  }
});

async function loadProject(name) {
  const body = $("#archive-body");
  body.innerHTML = `<div class="spinner"></div>`;
  try {
    const [files, deliverables, readiness, deliveryCheck, sessions, trash, brief] = await Promise.all([
      fetch(`/api/project/${encodeURIComponent(name)}/details`).then((r) => r.json()).catch(() => []),
      fetch(`/api/project/${encodeURIComponent(name)}/deliverables`).then((r) => r.json()).catch(() => null),
      fetch(`/api/project/${encodeURIComponent(name)}/readiness`).then((r) => r.json()).catch(() => null),
      fetch(`/api/project/${encodeURIComponent(name)}/delivery-check`).then((r) => r.json()).catch(() => null),
      fetch(`/api/projects/${encodeURIComponent(name)}/sessions`).then((r) => r.json()).catch(() => []),
      fetch(`/api/project/${encodeURIComponent(name)}/trash`).then((r) => r.json()).catch(() => []),
      fetch(`/api/project/${encodeURIComponent(name)}/brief`).then((r) => r.json()).catch(() => ({})),
    ]);
    body.innerHTML = `<button class="ghost-btn" id="back">← 返回</button><p class="fork-hint">${name}</p>`;
    $("#back").addEventListener("click", loadArchive);
    body.insertAdjacentHTML("beforeend", renderReadinessPanel(name, readiness));
    attachNextActionHandlers(body, name);
    attachHandoffHandlers(body, name);
    body.insertAdjacentHTML("beforeend", renderMobileDeliveryCheck(name, deliveryCheck));
    attachMobileDeliveryCheckHandlers(body, name);
    const projectEntry = projects.find((item) => item.name === name) || archiveProjects.find((item) => item.name === name) || {};
    body.insertAdjacentHTML("beforeend", renderMobileTagsPanel(name, projectEntry.tags || []));
    attachMobileTagsHandlers(body, name, projectEntry.tags || []);
    body.insertAdjacentHTML("beforeend", renderMobileBriefPanel(name, brief));
    attachMobileBriefHandlers(body, name, brief);
    body.insertAdjacentHTML("beforeend", renderMobileProjectType(name, readiness));
    attachMobileProjectTypeHandlers(body, name);
    body.insertAdjacentHTML("beforeend", renderMobileSessions(name, sessions));
    attachMobileSessionHandlers(body, name);
    body.insertAdjacentHTML("beforeend", renderDeliverableChecklist(name, deliverables));
    body.insertAdjacentHTML("beforeend", renderMobileTrash(name, trash));
    attachMobileTrashHandlers(body, name);
    body.querySelectorAll(".deliverable-generate").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const itemId = btn.dataset.deliverableId || "";
        pendingDeliverables.add(deliverableKey(name, itemId));
        btn.classList.add("pending");
        btn.disabled = true;
        btn.textContent = "等待";
        setActiveProject(name);
        activateChatTab();
        sendProjectPrompt(name, btn.dataset.deliverablePrompt || "");
      });
    });
    if (!files.length) {
      body.insertAdjacentHTML("beforeend", `<button class="manual-artifact-btn" type="button" id="mobile-new-artifact">＋ 新建产物</button>`);
      $("#mobile-new-artifact")?.addEventListener("click", () => openMobileCreator(name));
      body.insertAdjacentHTML("beforeend", `<p class="empty-hint">还没有产物</p>`);
      return;
    }
    body.insertAdjacentHTML("beforeend", `<button class="manual-artifact-btn" type="button" id="mobile-new-artifact">＋ 新建产物</button>`);
    $("#mobile-new-artifact")?.addEventListener("click", () => openMobileCreator(name));
    for (const artifact of files) {
      const f = artifact.file || artifact;
      const item = document.createElement("div");
      item.className = "file-item";
      item.innerHTML = `
        <strong>${escapeHtml(f)}</strong>
        <span class="proj-meta">${escapeHtml(typeLabel(artifact.type))} · ${formatBytes(artifact.size)} · ${formatDate(artifact.updatedAt)}</span>`;
      item.addEventListener("click", () => {
        loadPreview(name, f);
        // 切到预览面板
        document.querySelectorAll(".m-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".m-panel").forEach((p) => p.classList.remove("active"));
        document.querySelector('[data-tab="preview"]').classList.add("active");
        document.getElementById("tab-preview").classList.add("active");
      });
      body.appendChild(item);
    }
  } catch { body.innerHTML = `<p class="error-hint">加载失败</p>`; }
}

function renderMobileSessions(project, sessions) {
  const rows = (sessions || []).slice(0, 8).map((session) => `
    <button class="mobile-session-item" type="button" data-session-id="${escapeHtml(session.id)}">
      <span class="mobile-session-main">
        <strong>${escapeHtml(session.label || session.id?.slice(0, 12) || "历史会话")}</strong>
        <small>${escapeHtml(formatDateTime(session.createdAt))}</small>
      </span>
      <span class="mobile-session-action">继续</span>
    </button>`).join("");
  return `
    <div class="mobile-session-panel">
      <div class="proj-section">
        <span class="proj-section-label">会话</span>
        <span class="proj-section-count">${sessions?.length ?? 0}</span>
      </div>
      ${rows || `<p class="empty-inline">还没有历史会话。</p>`}
      <button class="manual-artifact-btn mobile-new-session" type="button" data-new-session-project="${escapeHtml(project)}">＋ 新建会话</button>
    </div>`;
}

function renderMobileTrash(project, trash) {
  if (!trash?.length) return "";
  const rows = trash.slice(0, 8).map((item) => `
    <div class="mobile-trash-item">
      <span class="mobile-session-main">
        <strong>${escapeHtml(item.file)}</strong>
        <small>${escapeHtml(formatDateTime(item.trashedAt))} · ${formatBytes(item.size)} · ${escapeHtml(typeLabel(item.type))}</small>
      </span>
      <button type="button" data-mobile-trash-file="${escapeHtml(item.trashedFile)}">恢复</button>
    </div>`).join("");
  return `
    <div class="mobile-trash-panel">
      <div class="proj-section">
        <span class="proj-section-label">回收站</span>
        <span class="proj-section-count">${trash.length}</span>
      </div>
      ${rows}
    </div>`;
}

function attachMobileTrashHandlers(root, project) {
  root.querySelectorAll("[data-mobile-trash-file]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await restoreMobileTrashArtifact(project, btn.dataset.mobileTrashFile || "", btn);
    });
  });
}

async function restoreMobileTrashArtifact(project, trashedFile, button) {
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
    await loadProjects();
    refreshMobileProjectView(project);
    if (data.artifact?.file) {
      await loadPreview(project, data.artifact.file);
      document.querySelectorAll(".m-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".m-panel").forEach((p) => p.classList.remove("active"));
      document.querySelector('[data-tab="preview"]').classList.add("active");
      document.getElementById("tab-preview").classList.add("active");
    }
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

function attachMobileSessionHandlers(root, project) {
  root.querySelectorAll("[data-session-id]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await loadMobileSessionHistory(project, btn.dataset.sessionId || "");
    });
  });
  root.querySelector("[data-new-session-project]")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setActiveProject(project);
    sessionId = null;
    cur = null;
    stream.innerHTML = "";
    showMobileEmpty();
    activateChatTab();
    createSession(project);
    toast("已新建会话");
  });
}

async function loadMobileSessionHistory(project, id) {
  if (!project || !id) return;
  setActiveProject(project, false);
  localStorage.setItem("pi-mobile-last-session", id);
  activateChatTab();
  stream.innerHTML = `<div class="spinner"></div>`;
  cur = null;
  sessionId = null;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
    if (!res.ok) throw new Error("history failed");
    const msgs = await res.json();
    stream.innerHTML = "";
    if (msgs.length) {
      msgs.forEach((m) => addBubble(m.role === "user" ? "user" : "assistant", m.text));
    } else {
      stream.innerHTML = `<p class="empty-hint">这个会话还没有可显示的消息。</p>`;
    }
    createSession(project, id);
    toast("正在继续历史会话");
  } catch {
    stream.innerHTML = "";
    showMobileEmpty();
    toast("会话加载失败");
  }
}

function refreshMobileProjectView(project) {
  const archivePanel = document.getElementById("tab-archive");
  if (!archivePanel?.classList.contains("active")) return;
  const heading = $("#archive-body .fork-hint");
  if (heading?.textContent === project) loadProject(project);
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
    `<li class="${escapeHtml(issue.level)}">${escapeHtml(issue.message)}</li>`,
  ).join("");
  const canRefine = currentArtifact && quality.status !== "ready";
  const pending = canRefine && pendingArtifactRefines.has(artifactKey(currentArtifact.project, currentArtifact.file));
  return `
    <section class="quality-banner ${escapeHtml(quality.status)}">
      <div class="quality-score">
        <strong>${Number(quality.score) || 0}</strong>
        <span>${escapeHtml(qualityLabel(quality.status))}</span>
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
      <span>${escapeHtml(deliverableLabel(deliverables))}</span>
    </div>`;
}

function renderDeliverableChecklist(project, deliverables) {
  if (!deliverables?.items?.length) return "";
  return `
    <div class="deliverable-panel mobile-deliverables">
      <div class="proj-meta">${escapeHtml(deliverableLabel(deliverables))}</div>
      ${deliverables.items.map((item) => `
        <div class="deliverable-item ${item.done ? "done" : ""}" data-deliverable-id="${escapeHtml(item.id)}">
          <span class="deliverable-mark">${item.done ? "✓" : "·"}</span>
          <span class="deliverable-copy">
            <strong>${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(item.done && item.matchedFile ? item.matchedFile : item.description)}</small>
          </span>
          ${renderDeliverableAction(project, item)}
        </div>`).join("")}
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
    <button class="next-action ${escapeHtml(action.tone || "info")}" type="button"
      data-next-action-id="${escapeHtml(action.id)}"
      data-next-action-prompt="${escapeHtml(action.prompt || "")}">
      <strong>${escapeHtml(action.title)}</strong>
      <span>${escapeHtml(action.description || "")}</span>
    </button>`).join("");
  return `
    <div class="readiness-panel mobile-readiness ${escapeHtml(readiness.status)}">
      <div class="readiness-head">
        <span class="readiness-score">${Number(readiness.score) || 0}</span>
        <span class="readiness-copy">
          <strong>${escapeHtml(readinessLabel(readiness.status))}</strong>
          <small>${escapeHtml(readiness.summary || "")}</small>
        </span>
      </div>
      <div class="readiness-facts">
        <span>${readiness.artifactCount ?? 0} 产物</span>
        <span>${readiness.deliverables?.done ?? 0}/${readiness.deliverables?.total ?? 0} 交付</span>
        <span>${readiness.readyArtifacts ?? 0} 可交付</span>
      </div>
      <div class="handoff-actions">
        <button class="handoff-btn" type="button" data-handoff-project="${escapeHtml(project)}">生成交接摘要</button>
        <button class="handoff-preview-btn" type="button" data-handoff-preview="${escapeHtml(project)}">预览摘要</button>
        <button class="handoff-preview-btn" type="button" data-delivery-package="${escapeHtml(project)}">下载交付包</button>
      </div>
      ${actions ? `<div class="next-actions">${actions}</div>` : ""}
    </div>`;
}

function renderMobileDeliveryCheck(project, check) {
  if (!check) return "";
  const blockers = check.blockers || [];
  const warnings = check.warnings || [];
  const items = [...blockers, ...warnings].slice(0, 5).map((item, index) => `
    <div class="delivery-check-item ${escapeHtml(item.severity || "warning")}">
      <span class="delivery-check-copy">
        <strong>${escapeHtml(item.title || "")}</strong>
        <small>${escapeHtml(item.detail || "")}</small>
      </span>
      ${item.prompt ? `<button type="button" data-delivery-check-prompt="${escapeHtml(item.prompt)}" data-delivery-check-index="${index}">处理</button>` : ""}
    </div>`).join("");
  return `
    <div class="delivery-check-panel ${check.ready ? "ready" : "blocked"}">
      <div class="proj-meta">${check.ready ? "交付检查 · 可交付" : `交付检查 · ${blockers.length} 阻塞`}</div>
      <p class="delivery-check-summary">${escapeHtml(check.summary || "")}</p>
      ${items ? `<div class="delivery-check-list">${items}</div>` : `<div class="delivery-check-ok">当前没有阻塞项，可以下载交付包。</div>`}
      <button type="button" class="delivery-check-download" data-delivery-package="${escapeHtml(project)}">下载交付包</button>
    </div>`;
}

function projectTypeLabel(type) {
  const value = String(type || "").toLowerCase();
  return PROJECT_TYPE_OPTIONS.find((item) => item.value === value)?.label || value || "通用创作";
}

function briefSummary(brief) {
  const parts = [brief?.goal, brief?.audience, brief?.acceptance].map((item) => String(item || "").trim()).filter(Boolean);
  return parts.length ? parts.join(" · ") : "补充目标、受众和验收口径";
}

function renderMobileBriefPanel(project, brief) {
  const hasBrief = ["goal", "audience", "background", "constraints", "acceptance"].some((key) => String(brief?.[key] || "").trim());
  return `
    <div class="mobile-brief-panel ${hasBrief ? "filled" : ""}">
      <span>
        <strong>项目简报</strong>
        <small>${escapeHtml(briefSummary(brief))}</small>
      </span>
      <button type="button" data-mobile-brief="${escapeHtml(project)}">${hasBrief ? "编辑" : "补充"}</button>
    </div>`;
}

function renderMobileTagsPanel(project, tags = []) {
  return `
    <div class="mobile-tags-panel">
      <span>
        <strong>项目标签</strong>
        <small>${tags.length ? tags.map((tag) => `#${tag}`).join(" · ") : "给项目加标签后，可以在档案室搜索"}</small>
      </span>
      <button type="button" data-mobile-tags="${escapeHtml(project)}">编辑</button>
    </div>`;
}

function attachMobileTagsHandlers(root, project, tags = []) {
  root.querySelectorAll("[data-mobile-tags]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      editMobileProjectTags(project, tags);
    });
  });
}

function attachMobileBriefHandlers(root, project, brief) {
  root.querySelectorAll("[data-mobile-brief]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openMobileBriefEditor(project, brief);
    });
  });
}

function renderMobileProjectType(project, readiness) {
  const current = String(readiness?.type || "create").toLowerCase();
  const hasCurrent = PROJECT_TYPE_OPTIONS.some((item) => item.value === current);
  const options = [
    ...PROJECT_TYPE_OPTIONS,
    ...(hasCurrent ? [] : [{ value: current, label: current }]),
  ].map((item) => `
    <option value="${escapeHtml(item.value)}" ${item.value === current ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  return `
    <div class="mobile-type-panel">
      <span>
        <strong>项目类型</strong>
        <small>${escapeHtml(projectTypeLabel(current))}</small>
      </span>
      <select data-mobile-project-type="${escapeHtml(project)}">${options}</select>
    </div>`;
}

function attachMobileProjectTypeHandlers(root, project) {
  root.querySelectorAll("[data-mobile-project-type]").forEach((select) => {
    select.addEventListener("change", async (ev) => {
      ev.stopPropagation();
      await updateMobileProjectType(project, select.value, select);
    });
  });
}

async function updateMobileProjectType(project, type, select) {
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
    await loadProjects();
    await loadDashboard();
    await loadProject(project);
    toast(`项目类型已切换为 ${projectTypeLabel(entry.type)}`);
  } catch (err) {
    if (select && previous) select.value = previous;
    toast(err.message || "类型更新失败");
  } finally {
    if (select) select.disabled = false;
  }
}

function openMobileBriefEditor(project, brief = {}) {
  const modal = $("#mobile-brief-modal");
  if (!modal) return;
  modal.dataset.project = project;
  $("#mobile-brief-meta").textContent = project;
  for (const key of ["goal", "audience", "background", "constraints", "acceptance"]) {
    const field = document.getElementById(`mobile-brief-${key}`);
    if (field) field.value = brief?.[key] || "";
  }
  modal.classList.remove("hidden");
  setTimeout(() => $("#mobile-brief-goal")?.focus(), 30);
}

function closeMobileBriefEditor() {
  $("#mobile-brief-modal")?.classList.add("hidden");
}

async function saveMobileBrief() {
  const modal = $("#mobile-brief-modal");
  const project = modal?.dataset.project || "";
  if (!project) return;
  const btn = $("#mobile-brief-save");
  const brief = {};
  for (const key of ["goal", "audience", "background", "constraints", "acceptance"]) {
    brief[key] = document.getElementById(`mobile-brief-${key}`)?.value || "";
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/project/${encodeURIComponent(project)}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(brief),
    });
    if (!res.ok) throw new Error("保存简报失败");
    closeMobileBriefEditor();
    await loadProjects();
    await loadDashboard();
    await loadProject(project);
    toast("项目简报已保存");
  } catch (err) {
    toast(err.message || "保存简报失败");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function activateChatTab() {
  document.querySelectorAll(".m-tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".m-panel").forEach((p) => p.classList.remove("active"));
  document.querySelector('[data-tab="chat"]').classList.add("active");
  document.getElementById("tab-chat").classList.add("active");
}

function runMobileWorkspaceAction(action) {
  if (!action?.project || !action?.prompt) return;
  setActiveProject(action.project);
  activateChatTab();
  sendProjectPrompt(action.project, action.prompt);
}

function openMobileWorkspaceActivity(item) {
  if (!item?.project) return;
  setActiveProject(item.project, false);
  if (item.kind === "session" && item.sessionId) {
    activateChatTab();
    loadSessionHistory(item.project, item.sessionId);
    return;
  }
  if (item.file) {
    loadPreview(item.project, item.file);
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
      setActiveProject(project);
      activateChatTab();
      sendProjectPrompt(project, prompt);
    });
  });
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

function attachMobileDeliveryCheckHandlers(root, project) {
  root.querySelectorAll("[data-delivery-check-prompt]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const prompt = btn.dataset.deliveryCheckPrompt || "";
      if (!prompt) return;
      btn.disabled = true;
      btn.textContent = "处理中";
      setActiveProject(project);
      activateChatTab();
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

function renderDeliverableAction(project, item) {
  if (item.done) return "";
  const pending = pendingDeliverables.has(deliverableKey(project, item.id));
  return `<button class="deliverable-generate ${pending ? "pending" : ""}" type="button" data-deliverable-id="${escapeHtml(item.id)}" data-deliverable-prompt="${escapeHtml(item.prompt || "")}" ${pending ? "disabled" : ""}>${pending ? "等待" : "生成"}</button>`;
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
    currentArtifact = null;
    const body = $("#preview-body");
    body.innerHTML = renderHandoffPreview(data);
    body.querySelector("[data-copy-handoff]")?.addEventListener("click", async () => {
      try {
        await copyText(data.content || "");
        toast("交接摘要已复制");
      } catch {
        toast("复制失败");
      }
    });
    document.querySelectorAll(".m-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".m-panel").forEach((p) => p.classList.remove("active"));
    document.querySelector('[data-tab="preview"]').classList.add("active");
    document.getElementById("tab-preview").classList.add("active");
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
    await loadProjects();
    refreshMobileProjectView(project);
    await loadPreview(data.project || project, data.file || "handoff-summary.md");
    document.querySelectorAll(".m-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".m-panel").forEach((p) => p.classList.remove("active"));
    document.querySelector('[data-tab="preview"]').classList.add("active");
    document.getElementById("tab-preview").classList.add("active");
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
          <strong>${escapeHtml(data?.project || "")}</strong>
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
      const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((cell) => escapeHtml(cell.trim()));
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
      html.push(`<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const bullet = trimmed.match(/^-\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${escapeHtml(trimmed)}</p>`);
  }
  closeList();
  closeTable();
  return `<div class="rendered-artifact">${html.join("")}</div>`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ── 预览 ──
async function loadPreview(project, file) {
  const body = $("#preview-body");
  currentArtifact = { project, file };
  body.innerHTML = `${previewHeader(project, file)}<div class="skeleton"></div><div class="skeleton short"></div>`;
  try {
    const [previewRes, qualityRes] = await Promise.all([
      fetch(`/api/preview?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`),
      fetch(`/api/artifact/quality?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`),
    ]);
    const data = previewRes.ok ? await previewRes.json() : { html: "" };
    const qualityData = qualityRes.ok ? await qualityRes.json() : null;
    body.innerHTML = previewHeader(project, file) + renderQualityBanner(qualityData?.quality) + (data.html || `<p class="empty-hint">空内容</p>`);
    body.querySelector("[data-quality-refine]")?.addEventListener("click", (ev) => {
      const btn = ev.currentTarget;
      pendingArtifactRefines.add(artifactKey(project, file));
      btn.classList.add("pending");
      btn.disabled = true;
      btn.textContent = "等待打磨";
      sendProjectPrompt(project, buildQualityRefinePrompt(project, file, qualityData?.quality));
      document.querySelectorAll(".m-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".m-panel").forEach((p) => p.classList.remove("active"));
      document.querySelector('[data-tab="chat"]').classList.add("active");
      document.getElementById("tab-chat").classList.add("active");
    });
  } catch { body.innerHTML = `<p class="error-hint">预览加载失败</p>`; }
}

function previewHeader(project, file) {
  return `
    <p class="m-preview-head">${escapeHtml(project)} / ${escapeHtml(file)}</p>
    <div class="m-preview-tools">
      <button type="button" data-preview-action="edit">编辑</button>
      <button type="button" data-preview-action="history">历史</button>
      <button type="button" data-preview-action="copy">复制</button>
      <button type="button" data-preview-action="download">下载</button>
      <button type="button" data-preview-action="raw">原文</button>
      <button type="button" data-preview-action="trash">移除</button>
    </div>`;
}

$("#preview-body").addEventListener("click", async (ev) => {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.previewAction;
  if (!action || !currentArtifact) return;
  const { project, file } = currentArtifact;
  if (action === "edit") {
    await openMobileEditor();
  } else if (action === "history") {
    await openMobileHistory();
  } else if (action === "download") {
    location.href = `/api/download?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`;
  } else if (action === "raw") {
    window.open(`/api/artifact?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`, "_blank", "noopener");
  } else if (action === "copy") {
    try {
      const data = await (await fetch(`/api/artifact?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`)).json();
      await copyText(data.content || "");
      toast("产物原文已复制");
    } catch {
      toast("复制失败");
    }
  } else if (action === "trash") {
    await trashMobileArtifact(project, file);
  }
});

async function trashMobileArtifact(project, file) {
  const ok = window.confirm(`移除产物「${file}」？文件会移入项目回收站，并保留历史版本。`);
  if (!ok) return;
  try {
    const res = await fetch("/api/artifact", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, file }),
    });
    if (!res.ok) throw new Error("trash failed");
    currentArtifact = null;
    $("#preview-body").innerHTML = `<p class="empty-hint">产物已移入项目回收站。</p>`;
    await loadProjects();
    refreshMobileProjectView(project);
    toast("产物已移除");
  } catch {
    toast("移除失败");
  }
}

$("#mobile-editor-close")?.addEventListener("click", closeMobileEditor);
$("#mobile-editor-cancel")?.addEventListener("click", closeMobileEditor);
$("#mobile-editor-save")?.addEventListener("click", saveMobileEditor);
$("#mobile-editor-modal")?.addEventListener("click", (ev) => {
  if (ev.target === $("#mobile-editor-modal")) closeMobileEditor();
});
$("#mobile-history-close")?.addEventListener("click", closeMobileHistory);
$("#mobile-history-modal")?.addEventListener("click", (ev) => {
  if (ev.target === $("#mobile-history-modal")) closeMobileHistory();
});

async function openMobileEditor() {
  if (!currentArtifact) return;
  const { project, file } = currentArtifact;
  const modal = $("#mobile-editor-modal");
  const title = $("#mobile-editor-title");
  const fileInput = $("#mobile-editor-file");
  const text = $("#mobile-editor-text");
  const meta = $("#mobile-editor-meta");
  const save = $("#mobile-editor-save");
  mobileEditorMode = "edit";
  mobileEditorProject = project;
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
    closeMobileEditor();
    toast("编辑器加载失败");
  }
}

function openMobileCreator(project) {
  const modal = $("#mobile-editor-modal");
  const title = $("#mobile-editor-title");
  const fileInput = $("#mobile-editor-file");
  const text = $("#mobile-editor-text");
  const meta = $("#mobile-editor-meta");
  const save = $("#mobile-editor-save");
  mobileEditorMode = "create";
  mobileEditorProject = project;
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

function closeMobileEditor() {
  $("#mobile-editor-modal")?.classList.add("hidden");
}

async function saveMobileEditor() {
  const fileInput = $("#mobile-editor-file");
  const text = $("#mobile-editor-text");
  const save = $("#mobile-editor-save");
  const project = mobileEditorMode === "create" ? mobileEditorProject : currentArtifact?.project;
  const file = mobileEditorMode === "create" ? fileInput.value.trim() : currentArtifact?.file;
  if (!project || !file) {
    toast("请填写项目和文件名");
    return;
  }
  save.disabled = true;
  try {
    const res = await fetch("/api/artifact", {
      method: mobileEditorMode === "create" ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, file, content: text.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || "save failed");
    }
    closeMobileEditor();
    currentArtifact = { project, file };
    await loadPreview(project, file);
    await loadProjects();
    refreshMobileProjectView(project);
    toast(mobileEditorMode === "create" ? "产物已创建" : "产物已保存");
  } catch (err) {
    toast((err instanceof Error && err.message.includes("already exists")) ? "文件已存在" : "保存失败");
  } finally {
    save.disabled = false;
  }
}

async function openMobileHistory() {
  if (!currentArtifact) return;
  const { project, file } = currentArtifact;
  const modal = $("#mobile-history-modal");
  const meta = $("#mobile-history-meta");
  const list = $("#mobile-history-list");
  modal.classList.remove("hidden");
  meta.textContent = `${project} / ${file}`;
  list.innerHTML = `<p class="empty-inline">加载历史中...</p>`;
  try {
    const res = await fetch(`/api/artifact/history?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error("history failed");
    renderMobileHistory(project, file, await res.json(), list);
  } catch {
    list.innerHTML = `<p class="error-hint">历史加载失败</p>`;
  }
}

function closeMobileHistory() {
  $("#mobile-history-modal")?.classList.add("hidden");
}

function renderMobileHistory(project, file, versions, list) {
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
        <strong>${escapeHtml(formatDateTime(version.createdAt))}</strong>
        <span>${formatBytes(version.size)} · ${escapeHtml(version.id)}</span>
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
        closeMobileHistory();
        await loadPreview(project, file);
        await loadProjects();
        toast("已恢复历史版本");
      } catch {
        toast("恢复失败");
      }
    });
    list.appendChild(row);
  });
}

// ── toast ──
let toastTimer = null;
function toast(t) {
  const el = $("#toast");
  el.textContent = t; el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}

function clearMobileEmpty() {
  $("#mobile-empty")?.remove();
}

function showMobileEmpty() {
  if ($("#mobile-empty")) return;
  stream.innerHTML = `
    <div class="m-empty" id="mobile-empty">
      <strong>准备开始</strong>
      <span>选择项目后即可对话，也可以先新建一个项目。</span>
      <div class="m-empty-actions">
        <button id="mobile-empty-new" type="button">新建</button>
        <button id="mobile-empty-archive" type="button">档案</button>
      </div>
    </div>`;
}

function escapeHtml(value) {
  const d = document.createElement("div");
  d.textContent = String(value ?? "");
  return d.innerHTML;
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

$("#mobile-brief-close")?.addEventListener("click", closeMobileBriefEditor);
$("#mobile-brief-cancel")?.addEventListener("click", closeMobileBriefEditor);
$("#mobile-brief-save")?.addEventListener("click", saveMobileBrief);

connect();
loadProjects();
loadDashboard();
loadStarters();
