// app.js — 工作台前端
//
// 问题: 把 WebSocket 的流式事件渲染成对话气泡,产物渲染到活页本面板,
//   并提供档案室浏览和二维码到手机。断连要自动重连。
//
// 方案: 单文件 ES module。WebSocket 收 {kind:"agent_event", event} 后按
//   event.type 渲染。产物预览走 HTTP /api/preview。无构建步骤,浏览器直接跑。

const $ = (sel) => document.querySelector(sel);
const stream = $("#stream");
const input = $("#input");
const conn = $("#conn");
const previewBody = $("#preview-body");
const previewTitle = $("#preview-title");

let ws = null;
let sessionId = null;
let mode = "create";
let curAssistant = null; // 当前正在流式的助手气泡元素
let reconnectTimer = null;

// ---- WebSocket 连接 + 自动重连 ----
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    conn.classList.add("ok");
    conn.title = "已连接";
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  ws.onclose = () => {
    conn.classList.remove("ok");
    conn.title = "断开，重连中…";
    reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else toast("未连接，正在重连…");
}

// ---- 处理服务端消息 ----
function handle(msg) {
  if (msg.kind === "created") {
    sessionId = msg.sessionId;
    return;
  }
  if (msg.kind === "mode_set") {
    return;
  }
  if (msg.kind === "fork_points") {
    renderForkPoints(msg.points, msg.leafId);
    return;
  }
  if (msg.kind === "forked") {
    // 分叉成功:清空对话流(从分叉点重新长),刷新分叉抽屉
    stream.innerHTML = "";
    curAssistant = null;
    renderForkPoints(msg.points, msg.leafId);
    toast("已分叉,从这里开一条新线");
    return;
  }
  if (msg.kind === "error") {
    toast("出错了：" + msg.message);
    finishAssistant();
    return;
  }
  if (msg.kind === "agent_event") {
    renderEvent(msg.event);
  }
}

// ---- 流式渲染 ----
function renderEvent(e) {
  switch (e.type) {
    case "message_start":
      // 不预建气泡：reasoning 模型会先发 thinking 的 message_start，
      // 预建会留下空泡。改为收到第一个 text_delta 时才建(见 message_update)。
      break;
    case "message_update": {
      const ame = e.assistantMessageEvent;
      if (ame?.type === "text_delta" && ame.delta) {
        if (!curAssistant) curAssistant = addBubble("assistant", "");
        appendText(curAssistant, ame.delta);
      }
      // thinking_delta 等暂不显示
      break;
    }
    case "tool_execution_start":
      addToolLine(`🔧 ${e.toolName}…`);
      break;
    case "tool_execution_end":
      // save_artifact 完成 → 刷新预览
      if (e.toolName === "save_artifact" && e.result?.details) {
        const { project, file } = e.result.details;
        loadPreview(project, file);
        toast(`已保存 ${project}/${file}`);
      }
      break;
    case "agent_end":
      finishAssistant();
      break;
  }
}

function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
  return div;
}
function appendText(el, t) {
  el.textContent += t;
  stream.scrollTop = stream.scrollHeight;
}
function addToolLine(t) {
  const div = document.createElement("div");
  div.className = "tool-line";
  div.textContent = t;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
}
function finishAssistant() {
  curAssistant = null;
}

// ---- 活页本预览(骨架屏 + 降级)----
async function loadPreview(project, file) {
  previewTitle.textContent = `${project} / ${file}`;
  previewBody.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div>`;
  try {
    const r = await fetch(`/api/preview?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`);
    const data = await r.json();
    previewBody.innerHTML = data.html || `<p class="empty-hint">空内容</p>`;
    previewBody.dataset.project = project;
    previewBody.dataset.file = file;
  } catch (err) {
    previewBody.innerHTML = `<p class="error-hint">预览暂时无法加载</p>`;
  }
}

// ---- 提交 ----
$("#composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addBubble("user", text);
  sendMsg({ type: "prompt", sessionId, payload: { text } });
  input.value = "";
});
input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) $("#composer").requestSubmit();
});

// ---- 模式切换 ----
document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    sendMsg({ type: "set_mode", sessionId, payload: { mode } });
    toast(mode === "work" ? "切到工作模式" : "切到创作模式");
  });
});

// ---- 档案室 ----
$("#archive-btn").addEventListener("click", openArchive);
$("#archive-close").addEventListener("click", () => $("#archive").classList.add("hidden"));
async function openArchive() {
  const drawer = $("#archive");
  const body = $("#archive-body");
  drawer.classList.remove("hidden");
  body.innerHTML = `<div class="spinner"></div>`;
  try {
    const projects = await (await fetch("/api/projects")).json();
    if (!projects.length) { body.innerHTML = `<p class="empty-hint">还没有项目</p>`; return; }
    body.innerHTML = "";
    for (const p of projects) {
      const card = document.createElement("div");
      card.className = "proj-card";
      card.innerHTML = `<strong>${p.name}</strong><span class="proj-meta">${p.type} · ${p.lastUpdated.slice(0,10)}</span>`;
      card.addEventListener("click", () => openProject(p.name));
      body.appendChild(card);
    }
  } catch {
    body.innerHTML = `<p class="error-hint">暂时无法加载</p>`;
  }
}
async function openProject(name) {
  const body = $("#archive-body");
  body.innerHTML = `<div class="spinner"></div>`;
  try {
    const files = await (await fetch(`/api/project/${encodeURIComponent(name)}`)).json();
    body.innerHTML = `<button class="ghost-btn" id="back">← 返回</button>`;
    $("#back").addEventListener("click", openArchive);
    for (const f of files) {
      const item = document.createElement("div");
      item.className = "file-item";
      item.textContent = f;
      item.addEventListener("click", () => { loadPreview(name, f); $("#archive").classList.add("hidden"); });
      body.appendChild(item);
    }
  } catch {
    body.innerHTML = `<p class="error-hint">暂时无法加载</p>`;
  }
}

// ---- 分叉树 ----
$("#fork-btn").addEventListener("click", () => {
  $("#fork").classList.remove("hidden");
  if (!sessionId) {
    $("#fork-body").innerHTML = `<p class="empty-hint">还没有对话,先说点什么再来分叉。</p>`;
    return;
  }
  sendMsg({ type: "fork_points", sessionId });
});
$("#fork-close").addEventListener("click", () => $("#fork").classList.add("hidden"));

function renderForkPoints(points, leafId) {
  const body = $("#fork-body");
  if (!points || !points.length) {
    body.innerHTML = `<p class="empty-hint">还没有可分叉的消息。</p>`;
    return;
  }
  body.innerHTML = `<p class="fork-hint">点任一历史消息,从那里开一条新的线。</p>`;
  points.forEach((p, i) => {
    const node = document.createElement("div");
    node.className = "fork-node";
    const isLeaf = leafId && p.entryId === leafId;
    node.innerHTML =
      `<span class="fork-dot">${i + 1}</span>` +
      `<span class="fork-text">${escapeHtmlClient(p.text).slice(0, 60)}</span>` +
      (isLeaf ? `<span class="fork-here">◀ 当前</span>` : "");
    node.addEventListener("click", () => {
      sendMsg({ type: "fork", sessionId, payload: { entryId: p.entryId } });
      $("#fork").classList.add("hidden");
    });
    body.appendChild(node);
  });
}

function escapeHtmlClient(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
$("#qr-btn").addEventListener("click", async () => {
  const project = previewBody.dataset.project;
  const file = previewBody.dataset.file;
  const path = project && file
    ? `/preview/x?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`
    : "/mobile";
  try {
    const data = await (await fetch(`/api/qr?path=${encodeURIComponent(path)}`)).json();
    $("#qr-img").src = data.dataUrl;
    $("#qr-target").textContent = data.target;
    $("#qr-modal").classList.remove("hidden");
  } catch { toast("二维码生成失败"); }
});
$("#qr-close").addEventListener("click", () => $("#qr-modal").classList.add("hidden"));

// ---- toast ----
let toastTimer = null;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
}

connect();
