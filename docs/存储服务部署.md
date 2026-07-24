# NAS MinIO 部署与外部接入

## 目的与原则

在 NAS 上运行独立 MinIO，用作生产或固定环境的 S3 兼容对象存储。业务服务器、数据库和 Web 服务可以重建或迁移，而媒体文件、导入文件和 AI 素材保留在 NAS。

本地开发不依赖 NAS：`dev.sh` 继续启动本地 MinIO。只有需要联调真实媒体、预发布或生产运行时，才配置外部 NAS endpoint。

> MinIO 对外暴露的是 S3 API，不是 WebDAV。不要用 WebDAV、SMB 或文件管理器直接修改 MinIO 的数据目录；对象必须通过 S3 API 或 MinIO Client (`mc`) 操作，以保证元数据一致性。

## NAS 部署

在 NAS 的一个专用目录（例如 `/volume1/containers/lexloop-minio`）保存以下 `compose.yml`。`/volume1/lexloop-minio/data` 必须是 NAS 的本地持久化磁盘路径，不应是 WebDAV 或远程挂载目录。

```yaml
services:
  minio:
    image: minio/minio:latest
    command: server /data --console-address ':9001'
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: "replace-with-non-default-admin"
      MINIO_ROOT_PASSWORD: "replace-with-a-long-random-secret"
      # 配置反向代理后取消注释，并改为外部 Console 地址。
      # MINIO_BROWSER_REDIRECT_URL: "https://minio-console.example.com"
    volumes:
      - /volume1/lexloop-minio/data:/data
    ports:
      - "9000:9000" # S3 API：仅允许业务服务器或反向代理访问
      - "9001:9001" # Console：仅管理员网络访问
```

启动：

```bash
docker compose up -d
```

部署后创建至少三个 bucket：`lexloop-dev`、`lexloop-staging`、`lexloop-prod`。开发、预发布和生产不得共用 bucket，也不要把真实用户媒体同步到开发 bucket。

## 网络与安全

- 使用反向代理（NAS 自带 Nginx、Caddy 或 Traefik）提供 HTTPS；业务端使用 HTTPS 的 S3 endpoint。
- 不将 Console `9001` 直接暴露到公网；限制为 VPN、内网或管理员 IP。
- S3 API 为应用创建最小权限的专用 access key，不能使用 root 账号。
- 按 bucket 配置 CORS，仅允许可信的 Web 域名。若由 API 发放预签名上传 URL，浏览器可直接上传，而 API 不需要转发大文件。
- 开启 bucket versioning；误删或覆盖时可恢复历史对象。

MinIO 的 S3 API、Console 与 CORS 配置说明可参考官方文档：[HTTP endpoints](https://docs.min.io/aistor/reference/aistor-server/http-endpoints/)、[CORS settings](https://docs.min.io/aistor/reference/aistor-server/settings/core/)。

## 应用接入配置

在**部署 API 和 Worker 的环境**设置以下变量；不要把 access key 或 secret 放入浏览器的 `NEXT_PUBLIC_*` 变量。

```dotenv
MINIO_ENDPOINT="https://s3.example.com"
MINIO_ACCESS_KEY="lexloop-server"
MINIO_SECRET_KEY="replace-with-application-secret"
MINIO_BUCKET="lexloop-prod"
MINIO_REGION="us-east-1"
```

当前工程已包含前三项的环境变量，但对象存储适配器尚未实现。后续接入时应增加 `StorageService`：

1. 使用 S3 兼容 SDK 连接上述 endpoint；本地和 NAS 使用同一个实现。
2. API 为授权用户生成限制对象键、媒体类型、大小和有效期的预签名上传 URL。
3. Web 直传文件到 MinIO；完成后调用 API 确认对象并写入业务表。
4. Worker 使用相同适配器读取导入文件、写入处理结果和 AI 生成素材。

## 备份与同步

NAS 减少了业务服务器故障带来的资源丢失风险，但 NAS 自身不是备份。RAID 只能降低单盘故障风险，不能防止误删、勒索或设备损坏。

推荐最小策略：

1. 开启 bucket versioning，并设置合理的历史版本生命周期。
2. 使用 NAS 快照保护 MinIO 的本地数据卷。
3. 定期将关键 bucket 复制到第二个独立位置，例如另一台 NAS、腾讯 COS 或离线备份盘。
4. 使用 `mc mirror` 或 S3 复制任务同步**对象**，不要通过 WebDAV 直接同步 MinIO 数据目录。
5. 定期进行恢复演练：从备份恢复一个测试 bucket，并校验对象数量和抽样文件哈希。

这样可以同时保留你习惯的 NAS 同步/备份能力，又不会破坏 MinIO 的对象存储一致性。
