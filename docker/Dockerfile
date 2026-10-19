# NoteLume 网页版（沙盒试用）容器镜像
# 构建位置：服务器仓库根，上下文 = 仓库根（dist 是构建产物、不入库，由部署脚本 tar 同步到 server/dist 后运行时挂载）
# stage 1：只装生产依赖（adm-zip / fast-xml-parser），node_modules 落在层里。
FROM node:22-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
# 跑非 root 用户：alpine 镜像自带的 node 用户（uid 1000），沙盒工作区在 /tmp 不受影响
USER node
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --chown=node:node server/serve.mjs server/package.json ./server/
COPY --chown=node:node server/src ./server/src
COPY --chown=node:node server/default-vault ./server/default-vault
# dist 不入库不进镜像：运行时由 compose 挂载宿主的 server/dist，升级前端只需重传产物 + 重启容器
EXPOSE 1420
# 容器内绑 0.0.0.0 才能被宿主 nginx 反代到；端口由 compose 只暴露到 127.0.0.1
# --data-dir：compose 把 server/ 源码挂成只读，且镜像里 /app/server 中间目录属 root（COPY --chown 不带新建父目录），
# node 用户唯一稳的可写落点是 /tmp（sessionBase 本来就在那）
CMD ["node", "server/serve.mjs", "--sandbox", "--host", "0.0.0.0", "--data-dir", "/tmp/notelume-data"]
