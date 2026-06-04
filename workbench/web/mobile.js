// mobile.js — 手机灵感入口
//
// 问题: 躺床上想到一句话,要能甩进工作台,电脑端 Pi 接着写。
// 方案: 复用同一 WebSocket 协议。无 sessionId 发 prompt → server 自动建 session(D8)。
//   手机端只读流式回复的简短确认,完整创作在电脑端看。

const $ = (s) => document.querySelector(s);
const stream = $("#stream");
const input = $("#input");
const conn = $("#conn");

let ws = null, sessionId = null, cur = null, reconnectTimer = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { conn.classList.add("ok"); if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };
  ws.onclose = () => { conn.classList.remove("ok"); reconnectTimer = setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function handle(msg) {
  if (msg.kind === "created") { sessionId = msg.sessionId; return; }
  if (msg.kind === "error") { toast("出错：" + msg.message); cur = null; return; }
  if (msg.kind === "agent_event") {
    const e = msg.event;
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      if (!cur) cur = addBubble("assistant", "");
      cur.textContent += e.assistantMessageEvent.delta;
      stream.scrollTop = stream.scrollHeight;
    } else if (e.type === "agent_end") cur = null;
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

$("#composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addBubble("user", text);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "prompt", sessionId, payload: { text } }));
  } else toast("未连接，正在重连…");
  input.value = "";
});

let toastTimer = null;
function toast(t) {
  const el = $("#toast");
  el.textContent = t; el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}

connect();
