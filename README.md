# Lexloop · 词环

英语闭环学习平台的全栈基础工程：Next.js Web、NestJS API、PostgreSQL/pgvector、Redis/BullMQ 与 MinIO。

## 本地启动

```bash
./dev.sh
```

- Web: http://localhost:52100
- API: http://localhost:52101/api/v1/health
- Swagger: http://localhost:52101/api/docs
- MinIO 控制台: http://localhost:9001

首次启动前请将 `.env` 中的两个 JWT 密钥替换成长随机字符串。AI 功能默认安全禁用，配置 `AI_API_KEY` 后再实现相应 Provider Adapter。

`dev.sh` 会自动加载 nvm（若当前终端没有 Node.js）、首次安装依赖、创建并导出根目录 `.env`、启动 Docker 服务、执行 Prisma 迁移，并同时运行 Web、API 和 Worker。它会在 Web 和 API 健康检查都通过后打印访问地址。按 `Ctrl+C` 可停止应用进程；基础设施容器仍会保留，可通过 `pnpm infra:down` 停止。

脚本会在启动前检查 Web（`52100`）和 API（`52101`）端口；如端口已被占用，会直接退出并显示占用进程 PID，避免只启动部分服务。

若之前的 watch 进程未退出，先执行 `./stop.sh`（或 `pnpm dev:stop`）再运行 `./dev.sh`。停止脚本只清理本仓库的 Web、API、Worker 与 Turbo 进程，不会停止 PostgreSQL、Redis、MinIO 或其他项目的进程。
