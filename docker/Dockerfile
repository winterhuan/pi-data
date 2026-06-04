# syntax=docker/dockerfile:1
FROM node:22-slim

# 安装 Pi + 工具
RUN npm install -g @earendil-works/pi-coding-agent \
    && npm cache clean --force

WORKDIR /app

# 复制 server 依赖 manifest 先(利用 layer 缓存)
COPY workbench/server/package*.json ./server/
RUN cd server && npm install --omit=dev && npm cache clean --force

# 复制源码
COPY workbench/server/ ./server/
COPY workbench/web/   ./web/
COPY pi-ext/workbench/ ./pi-ext/workbench/

# 把工作台扩展 symlink 到 Pi 全局扩展目录(同 E1 决定)
RUN mkdir -p /root/.pi/agent/extensions \
    && ln -sfn /app/pi-ext/workbench /root/.pi/agent/extensions/workbench

WORKDIR /app/server

ENV PORT=7777 \
    WORKBENCH_WORKSPACE=/workspace

EXPOSE 7777

CMD ["node", "--import", "tsx", "index.ts"]
