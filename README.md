# Pi 本地智能工作台

基于 [Pi](https://github.com/earendil-works/pi) 的本地智能工作台。浏览器打开,既能工作(数据分析、写代码),又能创作(散文、论文、小说、短剧、电影剧本),产物能扫码推到手机看。

## 它能做什么

- **活页本实时预览** — 左边对话,右边产物实时长出来:小说排成阅读页、剧本排成 Fountain 剧本页、数据排成表格
- **工作 / 创作双模式** — 顶栏切换,注入不同的 system prompt
- **按项目归档** — 产物存进 `workbench/workspace/{项目名}/`,档案室按项目浏览
- **项目整理** — 桌面端和手机端都能重命名项目,整理长期档案室
- **项目置顶** — 常用项目可置顶,在桌面列表、手机档案室和总览里优先出现
- **项目类型切换** — 已有项目可在桌面端和手机端切换创作、产品、分析、简报等类型,交付清单和成熟度建议会同步更新
- **项目简报** — 为项目保存目标、受众、背景、约束和验收口径,新会话会自动注入这些上下文以提高产出一致性
- **项目标签** — 桌面端和手机端都能给项目加标签,列表、档案室和全局搜索都能按标签定位
- **手机灵感入口** — 手机访问 `/mobile`,随手甩灵感进去,电脑端 Pi 接着写
- **手机继续会话** — 手机档案室可查看项目历史会话,点「继续」恢复上下文接着聊
- **手机分叉树** — 手机端也能查看当前会话节点,从历史用户消息处分叉继续
- **扫码看产物** — 任意产物生成二维码,手机扫码看渲染好的预览页
- **分叉树抽屉** — 会话内可视化当前路径、可分叉节点和当前 leaf,点用户消息即可从那里开新线
- **交付进度与质量检查** — 每个项目自动显示交付清单、产物质量、风险缺口和下一步动作
- **跨项目下一步行动队列** — 首页和手机端汇总所有项目的 readiness 动作,可一键切到对应项目并启动新会话推进
- **跨项目最近活动流** — 首页和手机端汇总最近产物与会话,可快速打开产物预览或恢复历史会话
- **干净交付包** — 桌面端和手机端可一键下载 `{项目名}-delivery.zip`,只包含交接 README、manifest 和当前产物
- **交付前检查** — 下载交付包前会检查缺失交付项、空项目和质量风险,未达标时先提示再允许继续
- **可行动交付检查面板** — 项目详情里直接显示阻塞项和建议项,可一键让 Pi 补齐或打磨
- **一键交接摘要** — 桌面端和手机端都能生成 `handoff-summary.md`,汇总项目状态、产物清单、风险和使用方式
- **产物回收站** — 桌面端和手机端都能移除误生成产物,文件进入项目 `trash/`,可在项目里查看并恢复

## 架构

```
浏览器/手机 ⇄ WebSocket + HTTP ⇄ workbench-server (Node)
                                      ↓ createAgentSession()
                                  Pi SDK + 工作台扩展(save_artifact)
                                      ↓
                                  workbench/workspace/{项目}/
```

SDK 嵌入式(Approach B):server 进程内直接 `createAgentSession()`,分叉树可直读 `sessionManager`。术语和产品边界见仓库内的 `CONTEXT.md`。

### 扩展边界

`pi-ext/workbench` 会被 symlink 到 `~/.pi/agent/extensions/workbench`,由 Pi SDK 按扩展路径加载。扩展代码不要 import `workbench/server/*`:相对路径会按 `~/.pi/agent/extensions/workbench` 解析,容易在启动时找不到模块。

server 和扩展共享两类轻量状态:

- `WORKBENCH_WORKSPACE`:server 启动时设置,扩展用它把 `save_artifact` / `save_bible` 写进同一个档案室。
- `globalThis.__workbenchSessionModes`:server 写入 `Map<sessionId, mode>`,扩展在 `before_agent_start` 读取,按会话注入工作/创作 prompt。

## 前置条件

- Pi 已全局安装(`pi --version` 应为 0.78+),`~/.pi/agent/` 配好 auth(`~/.pi/agent/auth.json` 或 API key 环境变量)
- Node 22+

## 安装与启动

```bash
cd workbench/server
npm install
npm run setup
npm run start:checked
# 浏览器打开 http://localhost:7777
```

`npm run setup` 会幂等安装 Pi 扩展 symlink 并检查 Node、Pi SDK、依赖、auth/model、workspace 等基础条件。
`npm run doctor` 只做诊断,不修改文件；旧项目里的中文 skill 名会作为 warning 报告,不会自动删除或迁移。

## 手机访问

本机开了 WSL2 mirrored 网络模式(`.wslconfig` 里 `networkingMode=mirrored`),
手机与电脑同局域网时,直接访问 `http://<本机IP>:7777`(当前 192.168.5.94)。
工作台里点「扫码看」会生成指向局域网 IP 的二维码,手机扫码即可。

若你的网络环境 IP 探测不对,可用环境变量覆盖:`WORKBENCH_LAN_IP=192.168.x.x npm start`

## 测试

```bash
cd workbench/server
npm test
npm run smoke:pi
```

`npm test` 不消耗模型。`npm run smoke:pi` 默认跳过真实 Pi 调用；需要真实端到端验收时执行
`WORKBENCH_REAL_PI_SMOKE=1 npm run smoke:pi`。

## 目录结构

```
workbench/
  server/        # SDK 嵌入式 server(HTTP + WebSocket)
    index.ts     #   入口 + auth 检测 + 静态服务
    session.ts   #   AgentSession 生命周期(Map + 30s/2min 超时)
    ws.ts        #   WebSocket 流式桥接
    api.ts       #   /api/* (项目/产物/预览/二维码/交接摘要)
    workspace.ts #   按项目归档、交付进度、交接摘要
    quality.ts   #   产物质量检查
    deliverables.ts # 项目交付清单定义
    starters.ts  #   起手式模板
    preview.ts   #   产物渲染(Markdown/Fountain/CSV)
    lan.ts       #   局域网 IP 探测(手机访问)
  web/           # 前端(无构建,浏览器直跑)
    index.html / app.js / style.css   # 主界面
    mobile.html / mobile.js           # 手机灵感入口
    preview.html                      # 扫码预览页
  workspace/     # 产物和创作圣经存放(按项目)
pi-ext/workbench/  # Pi 扩展:save_artifact/save_bible/read_bible + 工作/创作模式
```

## 还没做(后续)

- Docker 隔离(开发阶段先在 WSL 本机跑)
- 分叉树高级操作(折叠、标签编辑、搜索过滤)
- 手机端分叉树与会话恢复体验继续补齐
- 扩展加载链路的自动化回归测试(当前手动用 createAgentSession 验证)
