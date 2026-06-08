/**
 * ws.ts — WebSocket 流式桥接
 *
 * 问题: 浏览器/手机发的 prompt 要路由到对应 AgentSession,Pi 的流式事件
 * (message_update→text_delta 等)要实时推回正确的客户端连接。
 *
 * 方案: 每条入站消息形如 {sessionId?, type, payload}。
 *   - type=create: 新建 session(带 project/mode),回 {type:"created", sessionId}
 *   - type=prompt: 发给指定 session;无 sessionId 则自动建一个(手机灵感入口)
 *   - type=set_mode: 切换工作/创作模式(影响下一次 before_agent_start)
 *   每个连接订阅其 session 的事件流,转发 message_update/tool_execution/agent_end。
 *   连接关闭 → store.onDisconnect(30s paused / 2min 销毁)。
 *
 *   入站 → SessionStore → AgentSession.prompt()
 *   AgentSession.subscribe() → 出站 message_update/...  → 浏览器
 */

import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionStore, WorkbenchMode } from "./session.ts";

interface InboundMsg {
  sessionId?: string;
  type: "create" | "prompt" | "set_mode" | "fork_points" | "fork";
  payload?: {
    project?: string;
    mode?: WorkbenchMode;
    resumeSessionId?: string;
    text?: string;
    entryId?: string;
  } & Record<string, unknown>;
}

export function attachWebSocket(server: Server, store: SessionStore): void {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    // 本连接当前绑定的 sessionId 和事件取消订阅函数
    let boundId: string | undefined;
    let unsub: (() => void) | undefined;

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    /** 把一个 session 的事件流接到本连接。 */
    const bind = (id: string) => {
      const m = store.get(id);
      if (!m) return;
      if (unsub) unsub();
      boundId = id;
      store.onReconnect(id); // 取消可能存在的暂停/销毁定时器
      unsub = m.session.subscribe((event) => {
        // 直接把 Pi 的事件透传给前端;前端按 type 渲染
        send({ kind: "agent_event", sessionId: id, event });
      });
    };

    ws.on("message", async (raw) => {
      let msg: InboundMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ kind: "error", message: "bad json" });
        return;
      }

      try {
        if (msg.type === "create") {
          const project = String(msg.payload?.project ?? "未命名项目");
          const mode = (msg.payload?.mode ?? "create") as WorkbenchMode;
          const resumeSessionId = msg.payload?.resumeSessionId ? String(msg.payload.resumeSessionId) : undefined;
          const m = await store.create(project, mode, resumeSessionId);
          bind(m.id);
          send({ kind: "created", sessionId: m.id, project: m.project, mode: m.mode, resumed: Boolean(resumeSessionId) });
          return;
        }

        if (msg.type === "prompt") {
          // 路由到指定 session;无 session 时要求客户端先选项目并 create。
          let id = msg.sessionId ?? boundId;
          if (!id || !store.get(id)) {
            send({ kind: "error", message: "请先选择项目并创建会话" });
            return;
          }
          if (id !== boundId) bind(id);
          const m = store.get(id)!;
          // prompt 是异步流式的;不 await 阻塞消息循环,错误经事件流/catch 上报
          m.session.prompt(String(msg.payload?.text ?? "")).catch((err) => {
            send({ kind: "error", sessionId: id, message: (err as Error).message });
          });
          return;
        }

        if (msg.type === "set_mode") {
          const id = msg.sessionId ?? boundId;
          if (id) store.setMode(id, (msg.payload?.mode ?? "create") as WorkbenchMode);
          const m = id ? store.get(id) : undefined;
          send({ kind: "mode_set", sessionId: m?.id, mode: m?.mode, applies: "next_turn" });
          return;
        }

        if (msg.type === "fork_points") {
          const id = msg.sessionId ?? boundId;
          if (!id) { send({ kind: "fork_points", points: [], leafId: null }); return; }
          const tree = store.forkPoints(id);
          send({ kind: "fork_points", sessionId: id, ...tree });
          return;
        }

        if (msg.type === "fork") {
          const id = msg.sessionId ?? boundId;
          const target = msg.payload?.entryId;
          if (!id || !target) { send({ kind: "error", message: "fork 缺少 sessionId/entryId" }); return; }
          await store.fork(id, target);
          // 分叉后回传新的分叉点状态,前端刷新树
          const tree = store.forkPoints(id);
          send({ kind: "forked", sessionId: id, ...tree });
          return;
        }

        send({ kind: "error", message: `unknown type: ${msg.type}` });
      } catch (err) {
        send({ kind: "error", message: (err as Error).message });
      }
    });

    ws.on("close", () => {
      if (unsub) unsub();
      if (boundId) store.onDisconnect(boundId);
    });
  });
}
