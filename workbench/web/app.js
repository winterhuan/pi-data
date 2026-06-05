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
}

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    document.getElementById("conn").classList.add("ok");
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (appState === "reconnecting") setState(activeProject ? "active" : "no-project");
  };
  ws.onclose = () => {
    document.getElementById("conn").classList.remove("ok");
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
    setState("active");
    if (pendingText) { const t = pendingText; pendingText = null; wsSend({ type: "prompt", sessionId, payload: { text: t } }); setState("streaming"); }
    return;
  }
  if (msg.kind === "error") { toast("出错了：" + msg.message); if (appState === "streaming") setState("active"); finishAssistant(); return; }
  if (msg.kind === "fork_points") { renderForkPoints(msg.points, msg.leafId); return; }
  if (msg.kind === "forked") {
    document.getElementById("stream").innerHTML = ""; curAssistant = null;
    renderForkPoints(msg.points, msg.leafId); toast("已分叉，从这里开新线");
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
      loadPreview(project, file); toast(`已保存 ${file}`);
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
}

function renderProjectList(projects) {
  const list = document.getElementById("proj-list");
  list.innerHTML = "";
  const q = document.getElementById("proj-search").value.trim().toLowerCase();
  const filtered = q ? projects.filter(p => p.name.toLowerCase().includes(q)) : projects;
  if (!filtered.length) {
    list.innerHTML = `<p style="padding:.75rem;font-size:.82rem;color:var(--fg-dim)">没有项目</p>`;
    return;
  }
  filtered.forEach(p => {
    const item = document.createElement("div");
    item.className = "proj-item"; item.dataset.name = p.name;
    item.innerHTML = `<div class="proj-header ${activeProject === p.name ? "active" : ""}"><span class="proj-toggle">▶</span><span class="proj-name">${esc(p.name)}</span></div><div class="proj-children"></div>`;
    item.querySelector(".proj-header").addEventListener("click", () => toggleProject(p.name, item));
    list.appendChild(item);
  });
}

async function toggleProject(name, itemEl) {
  const header = itemEl.querySelector(".proj-header");
  const children = itemEl.querySelector(".proj-children");
  const toggle = itemEl.querySelector(".proj-toggle");
  if (children.classList.contains("open")) { children.classList.remove("open"); toggle.textContent = "▶"; return; }
  children.classList.add("open"); toggle.textContent = "▼"; header.classList.add("active");
  activeProject = name; setState("loading-project");

  try {
    const [sessions, bible, skills] = await Promise.all([
      fetch(`/api/projects/${encodeURIComponent(name)}/sessions`).then(r => r.json()).catch(() => []),
      fetch(`/api/projects/${encodeURIComponent(name)}/bible`).then(r => r.json()).catch(() => []),
      fetch(`/api/projects/${encodeURIComponent(name)}/skills`).then(r => r.json()).catch(() => []),
    ]);
    children.innerHTML = "";

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
        el.innerHTML = `<span class="skill-icon">▷</span>${esc(sk.name)}`; el.title = sk.description;
        el.addEventListener("click", () => invokeSkill(name, sk.name)); skSec.appendChild(el);
      });
      children.appendChild(skSec);
    }

    if (sessions.length === 0) {
      setState("no-project");
      document.getElementById("state-no-project").querySelector("p").textContent = "还没有会话，点「新建会话」开始";
    } else {
      startSession(name);
    }
    saveRecent({ type: "project", name, label: name });
  } catch (err) { setState("failed", "加载失败：" + err.message); }
}

function startSession(project) {
  activeProject = project;
  document.getElementById("stream").innerHTML = ""; curAssistant = null; sessionId = null;
  setState("creating-session");
  wsSend({ type: "create", payload: { project, mode } });
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

// ── 加载历史会话内容 ────────────────────────────────────────────────────────
async function loadSessionHistory(project, id) {
  activeProject = project; sessionId = null;
  const stream = document.getElementById("stream");
  stream.innerHTML = ""; curAssistant = null;
  setState("loading-project");
  try {
    const msgs = await (await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`)).json();
    setState("active");
    msgs.forEach(m => addBubble(m.role === "user" ? "user" : "assistant", m.text));
    stream.scrollTop = stream.scrollHeight;
    // 后续发消息时在这个历史会话上继续 — 新建 Pi session
    startSession(project);
  } catch { setState("failed", "加载会话失败"); }
}

// ── 提交 ──────────────────────────────────────────────────────────────────
document.getElementById("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = document.getElementById("input").value.trim();
  if (!text) return;
  addBubble("user", text); document.getElementById("input").value = "";
  if (!sessionId) { pendingText = text; startSession(activeProject || "未命名项目"); return; }
  wsSend({ type: "prompt", sessionId, payload: { text } }); setState("streaming");
});
document.getElementById("input").addEventListener("keydown", ev => {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) document.getElementById("composer").requestSubmit();
});

// ── 模式切换 ──────────────────────────────────────────────────────────────
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active"); mode = btn.dataset.mode;
    if (sessionId) wsSend({ type: "set_mode", sessionId, payload: { mode } });
    toast(mode === "work" ? "工作模式" : "创作模式");
  });
});

// ── 预览 ──────────────────────────────────────────────────────────────────
async function loadPreview(project, file) {
  document.getElementById("preview-title").textContent = file;
  const body = document.getElementById("preview-body");
  body.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div>`;
  body.dataset.project = project; body.dataset.file = file;
  try {
    const data = await (await fetch(`/api/preview?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`)).json();
    body.innerHTML = data.html || `<p class="empty-hint">空内容</p>`;
  } catch { body.innerHTML = `<p class="error-hint">预览加载失败</p>`; }
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

// ── 分叉树 ────────────────────────────────────────────────────────────────
document.getElementById("fork-btn").addEventListener("click", () => {
  document.getElementById("fork-drawer").classList.remove("hidden");
  if (sessionId) wsSend({ type: "fork_points", sessionId });
});
document.getElementById("fork-close").addEventListener("click", () => document.getElementById("fork-drawer").classList.add("hidden"));
function renderForkPoints(points, leafId) {
  const body = document.getElementById("fork-body");
  if (!points?.length) { body.innerHTML = `<p class="empty-hint">没有可分叉的消息</p>`; return; }
  body.innerHTML = "";
  points.forEach((p, i) => {
    const node = document.createElement("div");
    node.className = `fork-node${leafId && p.entryId === leafId ? " current" : ""}`;
    node.innerHTML = `<span class="fork-dot">${i+1}</span><span class="fork-text">${esc(p.text).slice(0,60)}</span>${leafId && p.entryId === leafId ? `<span class="fork-here">◀ 当前</span>` : ""}`;
    node.addEventListener("click", () => { wsSend({ type: "fork", sessionId, payload: { entryId: p.entryId } }); document.getElementById("fork-drawer").classList.add("hidden"); });
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
document.getElementById("new-proj-confirm").addEventListener("click", () => {
  const name = document.getElementById("new-proj-name").value.trim();
  if (!name) return;
  document.getElementById("new-proj-modal").classList.add("hidden");
  allProjects.push({ id: name, name, type: "create", lastUpdated: new Date().toISOString() });
  renderProjectList(allProjects);
  const items = document.querySelectorAll(".proj-item");
  for (const item of items) { if (item.dataset.name === name) { item.querySelector(".proj-header").click(); break; } }
  toast(`项目「${name}」已创建`);
});
document.getElementById("new-proj-name").addEventListener("keydown", ev => {
  if (ev.key === "Enter") document.getElementById("new-proj-confirm").click();
  if (ev.key === "Escape") document.getElementById("new-proj-cancel").click();
});

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

let palFocus = -1;
function openPalette() {
  document.getElementById("palette").classList.remove("hidden");
  document.getElementById("palette-input").value = ""; palFocus = -1;
  renderPaletteResults(""); setTimeout(() => document.getElementById("palette-input").focus(), 30);
}
function closePalette() { document.getElementById("palette").classList.add("hidden"); }

function renderPaletteResults(q) {
  const results = document.getElementById("palette-results");
  results.innerHTML = ""; palFocus = -1;
  if (!q) {
    const recents = getRecents();
    if (!recents.length) { results.innerHTML = `<p style="padding:.75rem 1rem;font-size:.82rem;color:var(--fg-dim)">开始输入搜索项目</p>`; return; }
    results.innerHTML = `<div class="palette-section-head">最近访问</div>`;
    recents.slice(0, 5).forEach(r => addPaletteItem(results, r.type === "project" ? "📂" : "💬", r.label, r.type, r));
    return;
  }
  const lq = q.toLowerCase();
  const matched = allProjects.filter(p => p.name.toLowerCase().includes(lq));
  if (matched.length) { results.innerHTML = `<div class="palette-section-head">项目</div>`; matched.slice(0,8).forEach(p => addPaletteItem(results, "📂", p.name, "project", p)); }
  else results.innerHTML = `<p style="padding:.75rem 1rem;font-size:.82rem;color:var(--fg-dim)">没有匹配结果</p>`;
}
function addPaletteItem(container, icon, label, type, data) {
  const el = document.createElement("div"); el.className = "palette-item";
  el.innerHTML = `<span class="palette-item-icon">${icon}</span><span class="palette-item-label">${esc(label)}</span><span class="palette-item-meta">${type}</span>`;
  el.addEventListener("click", () => {
    closePalette();
    if (type === "project") {
      const items = document.querySelectorAll(".proj-item");
      for (const item of items) { if (item.dataset.name === data.name) { item.querySelector(".proj-header").click(); break; } }
    }
  });
  container.appendChild(el);
}
document.getElementById("palette-input").addEventListener("input", ev => renderPaletteResults(ev.target.value));
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
connect();
loadProjectList();
