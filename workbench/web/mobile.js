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
  if (msg.kind === "mode_set") return;
  if (msg.kind === "agent_event") {
    const e = msg.event;
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      if (!cur) cur = addBubble("assistant", "");
      cur.textContent += e.assistantMessageEvent.delta;
      stream.scrollTop = stream.scrollHeight;
    } else if (e.type === "tool_execution_end" && e.toolName === "save_artifact") {
      const { project, file } = e.result?.details ?? {};
      if (project && file) { toast(`已保存 ${file}`); setActiveProject(project, false); loadProjects(); loadPreview(project, file); }
    } else if (e.type === "tool_execution_end" && e.toolName === "save_bible") {
      const { project } = e.result?.details ?? {};
      if (project) { setActiveProject(project, false); loadProjects(); toast("创作设定已保存"); }
    } else if (e.type === "agent_end") { cur = null; }
  }
}

function addBubble(role, text) {
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
  if (!activeProject) { toast("先选择或创建项目"); return; }
  addBubble("user", text);
  if (!sessionId) {
    pendingText = text;
    createSession(activeProject);
  } else {
    sendMsg({ type: "prompt", sessionId, payload: { text } });
  }
  input.value = "";
});

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

// ── 项目选择 ──
async function loadProjects() {
  try {
    projects = await (await fetch("/api/projects")).json();
  } catch {
    projects = [];
  }
  renderProjectSelect();
  const last = localStorage.getItem("pi-mobile-last-project");
  if (!activeProject && last && projects.some((p) => p.name === last)) setActiveProject(last, false);
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
  if (resetSession) { sessionId = null; cur = null; stream.innerHTML = ""; }
  renderProjectSelect();
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

// ── 档案室 ──
async function loadArchive() {
  const body = $("#archive-body");
  body.innerHTML = `<div class="spinner"></div>`;
  try {
    const projects = await (await fetch("/api/projects")).json();
    if (!projects.length) { body.innerHTML = `<p class="empty-hint">还没有项目</p>`; return; }
    body.innerHTML = "";
    for (const p of projects) {
      const card = document.createElement("div");
      card.className = "proj-card";
      card.innerHTML = `<strong>${p.name}</strong><span class="proj-meta">${p.type} · ${p.lastUpdated.slice(0,10)}</span>`;
      card.addEventListener("click", () => { setActiveProject(p.name); loadProject(p.name); });
      body.appendChild(card);
    }
  } catch { body.innerHTML = `<p class="error-hint">加载失败</p>`; }
}

async function loadProject(name) {
  const body = $("#archive-body");
  body.innerHTML = `<div class="spinner"></div>`;
  try {
    const files = await (await fetch(`/api/project/${encodeURIComponent(name)}`)).json();
    body.innerHTML = `<button class="ghost-btn" id="back">← 返回</button><p class="fork-hint">${name}</p>`;
    $("#back").addEventListener("click", loadArchive);
    for (const f of files) {
      const item = document.createElement("div");
      item.className = "file-item";
      item.textContent = f;
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

// ── 预览 ──
async function loadPreview(project, file) {
  const body = $("#preview-body");
  body.innerHTML = `<p class="m-preview-head">${project} / ${file}</p><div class="skeleton"></div><div class="skeleton short"></div>`;
  try {
    const data = await (await fetch(`/api/preview?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`)).json();
    body.innerHTML = `<p class="m-preview-head">${project} / ${file}</p>` + (data.html || `<p class="empty-hint">空内容</p>`);
  } catch { body.innerHTML = `<p class="error-hint">预览加载失败</p>`; }
}

// ── toast ──
let toastTimer = null;
function toast(t) {
  const el = $("#toast");
  el.textContent = t; el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}

connect();
loadProjects();
