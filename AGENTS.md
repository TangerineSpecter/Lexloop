# Lexloop 协作约定

## 先读什么

- 修改前端界面、布局或视觉样式前，先阅读并遵循 `DESIGN.md`。
- 涉及系统边界、基础设施或数据流前，先阅读 `docs/系统架构.md`。

## 架构边界

- 本仓库是 pnpm workspace + Turborepo：`apps/web`（Next.js）、`apps/api`（NestJS）、`apps/worker`（BullMQ）与 `packages/types`（共享类型）。
- Web 只能通过 API 客户端访问业务数据；不得直接访问数据库、Redis、对象存储或 AI Provider。
- API 是按业务域划分的 NestJS 模块化单体：Controller 处理 HTTP，Service 承载业务规则，DTO 负责校验与传输类型。
- 数据结构变更必须更新 Prisma schema 并创建 migration；不要直接修改数据。
- Worker 只执行异步、可重试的任务；API 不等待长耗时任务完成。

## 结构与重构

- 页面负责路由、页面级数据加载与组装；独立功能区、弹窗和可复用交互拆到业务组件中。
- 当一个 React 文件同时包含多个独立功能区，或同时负责数据请求、复杂状态和展示时，按职责拆分；不要继续堆入同一文件。
- 特定业务的组件、常量、类型和样式应邻近放置；只有跨功能复用的内容才放进共享 `components`、`lib` 或 `packages/types`。
- 重构保持现有 URL、API 合约和用户可见行为兼容，除非需求明确要求变更。

## 验证与文档

- 只验证受影响的应用或包；前端 TypeScript 改动运行 `pnpm --filter @lexloop/web typecheck`，API 改动运行 `pnpm --filter @lexloop/api typecheck`，业务规则变更补充或运行对应测试。
- 改变用户可见行为、设计系统、模块边界或数据流时，同步更新相关文档。
- 不提交密钥、令牌、真实用户数据或本地环境文件。
