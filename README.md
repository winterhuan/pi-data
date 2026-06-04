# Pi 本地智能工作台

基于 [Pi](https://github.com/earendil-works/pi) 的本地智能工作台。浏览器打开,既能工作(数据分析、写代码),又能创作(散文、论文、小说、短剧、电影剧本),产物能扫码推到手机看。

## 它能做什么

- **活页本实时预览** — 左边对话,右边产物实时长出来:小说排成阅读页、剧本排成 Fountain 剧本页、数据排成表格
- **工作 / 创作双模式** — 顶栏切换,注入不同的 system prompt
- **按项目归档** — 产物存进 `workbench/workspace/{项目名}/`,档案室按项目浏览
- **手机灵感入口** — 手机访问 `/mobile`,随手甩灵感进去,电脑端 Pi 接着写
- **扫码看产物** — 任意产物生成二维码,手机扫码看渲染好的预览页

## 架构

```
浏览器/手机 ⇄ WebSocket + HTTP ⇄ workbench-server (Node)
                                      ↓ createAgentSession()
                                  Pi SDK + 工作台扩展(save_artifact)
                                      ↓
                                  workbench/workspace/{项目}/
```

SDK 嵌入式(Approach B):server 进程内直接 `createAgentSession()`,分叉树可直读 `sessionManager`。详见 `~/.gstack/projects/pi-data/ceo-plans/2026-06-04-pi-workbench.md`。

## 前置条件

- Pi 已全局安装(`pi --version` 应为 0.78+),`~/.pi/agent/` 配好 auth(`~/.pi/agent/auth.json` 或 API key 环境变量)
- Node 22+

## 安装与启动

```bash
# 1. 安装 server 依赖(隔离,不污染全局 Pi)
cd workbench/server && npm install

# 2. 把工作台扩展 symlink 到 Pi 扩展目录(让 save_artifact / 模式切换生效)
ln -sfn "$(git rev-parse --show-toplevel)/pi-ext/workbench" ~/.pi/agent/extensions/workbench

# 3. 启动
cd workbench/server && npm start
# 浏览器打开 http://localhost:7777
```

## 手机访问

本机开了 WSL2 mirrored 网络模式(`.wslconfig` 里 `networkingMode=mirrored`),
手机与电脑同局域网时,直接访问 `http://<本机IP>:7777`(当前 192.168.5.94)。
工作台里点「扫码看」会生成指向局域网 IP 的二维码,手机扫码即可。

若你的网络环境 IP 探测不对,可用环境变量覆盖:`WORKBENCH_LAN_IP=192.168.x.x npm start`

## 测试

```bash
cd workbench/server
npx vitest run preview.test.ts   # 渲染器单元测试(无需 API key)
```

Pi 升级后,跑一遍确认渲染器没回归;再手动开一次工作台发条消息确认流式输出正常。

## 目录结构

```
workbench/
  server/        # SDK 嵌入式 server(HTTP + WebSocket)
    index.ts     #   入口 + auth 检测 + 静态服务
    session.ts   #   AgentSession 生命周期(Map + 30s/2min 超时)
    ws.ts        #   WebSocket 流式桥接
    api.ts       #   /api/* (项目/产物/预览/二维码)
    workspace.ts #   按项目归档
    preview.ts   #   产物渲染(Markdown/Fountain/CSV)
    lan.ts       #   局域网 IP 探测(手机访问)
  web/           # 前端(无构建,浏览器直跑)
    index.html / app.js / style.css   # 主界面
    mobile.html / mobile.js           # 手机灵感入口
    preview.html                      # 扫码预览页
  workspace/     # 产物存放(按项目)
pi-ext/workbench/  # Pi 扩展:save_artifact + 工作/创作模式
```

## 还没做(后续)

- Docker 隔离(开发阶段先在 WSL 本机跑)
- 分叉树完整可视化(当前可分叉,UI 待做)
- 手机端完整操控(当前只读预览 + 发灵感)
- 长篇结构化大脑(人物表/章节大纲)
