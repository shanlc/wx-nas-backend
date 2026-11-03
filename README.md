# 微信小程序自托管后端（群晖 NAS Docker 部署）

原来存在微信云开发里的数据，改存到你自己的群晖 NAS 上。

## 它能做什么

- 微信登录：小程序 `wx.login()` 的 code 换 openid，返回 JWT
- 用户资料：`GET/PUT /api/user/me`
- 通用数据：`POST/GET/PUT/DELETE /api/data/:collection`，按用户隔离，替代云数据库
- 文件：`POST /api/upload`、`GET /api/files/:id`，替代云存储
- 批量导入：`POST /api/data/:collection/import`，用于云开发导出后的迁移
- 数据存在 SQLite 文件 `data/app.db` + `data/uploads/`，Docker volume 映射到 NAS 即持久化，不用另外装 MySQL

## 群晖部署（Container Manager）

1. 把本仓库放到 NAS，例如 `/volume1/docker/wx-nas-backend`，并在该目录下建 `data/` 文件夹。
2. 在 Container Manager -> 项目 -> 新增，粘贴 `docker-compose.yml`，把 `volumes` 的 `./data` 改成 NAS 绝对路径，例如 `/volume1/docker/wx-nas-backend/data:/app/data`。
3. 在项目环境变量里填（不要写进公开仓库）：
   - `WECHAT_APPID`：小程序 AppID
   - `WECHAT_SECRET`：小程序 AppSecret
   - `JWT_SECRET`：随机长字符串，如 `openssl rand -hex 32` 的输出
4. 启动，浏览器打开 `http://NAS_IP:3000/health`，看到 `{"ok":true}` 即成功。

## 本地 / 服务器 Docker Compose 部署

```bash
cp .env.example .env   # 填好三项
docker compose up -d --build
curl http://localhost:3000/health
```

## 小程序端怎么改

见 `miniprogram-example/utils/api.js`：把 `wx.cloud.database()` / `wx.cloud.uploadFile()` 的调用换成这里的 `db.add/list/update/remove` 和 `uploadFile`，先调一次 `login()` 拿到 token。

小程序正式版注意两点：

1. 服务器域名必须是 HTTPS，且在微信后台 -> 开发管理 -> 服务器域名 -> request 合法域名里配置。
2. 群晖外网访问建议走反向代理（Synology 反向代理服务器 + 域名 + Let's Encrypt 证书），不要直接把 3000 端口暴露到公网且不设防火墙。

## 从微信云开发迁移数据

1. 微信云开发控制台 -> 数据库 -> 导出集合为 JSON（或用云函数导出）。
2. 小程序登录一次，拿到 token。
3. `node tools/import.js http://NAS_IP:3000 <token> <集合名> <导出的.json>`，分批导入，每批最多 500 条。
4. 云存储文件：先从控制台批量下载，再用 `/api/upload` 逐个上传，或直接放到 `data/uploads/` 并在 `files` 表补记录（不推荐手改表）。

## 接口速查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /health | 健康检查 |
| POST | /api/auth/login | {code} -> {token, user} |
| GET/PUT | /api/user/me | 用户资料 |
| POST | /api/data/:collection | 新增一条 |
| GET | /api/data/:collection?page=&pageSize= | 查自己的列表 |
| GET/PUT/DELETE | /api/data/:collection/:id | 查/改/删一条 |
| POST | /api/data/:collection/import | {items:[...]} 批量导入 |
| POST | /api/upload | form-data file 字段，单个 ≤20MB |
| GET | /api/files/:id | 下载自己上传的文件 |

集合名只允许字母、数字、`-`、`_`，最多 64 字符。

## 安全提醒

- `.env`、AppSecret、JWT_SECRET 绝不要提交到 GitHub。
- 生产环境保持 `ALLOW_DEV_LOGIN=false`。
- 定期备份 NAS 上的 `data/` 文件夹，那就是你的全部数据。
