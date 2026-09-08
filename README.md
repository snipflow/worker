# Snipflow Worker

Snipflow Worker 是部署在 Cloudflare Workers 上的轻量对象存储 API。它可以保存文本、JSON、图片、文档和任意二进制内容，不要求 JSON 包装，也不限制为固定的文件类别。

你只需要一个 Cloudflare 账号、一个 KV namespace、一个 R2 bucket 和一个访问 Token。本文面向部署者和 API 使用者；如需了解内部实现或从零复刻项目，请阅读 [architecture.md](./architecture.md)。

## 快速部署

### 1. 准备环境

本地需要 Node.js、pnpm 和可用的 Cloudflare 账号。

~~~bash
pnpm install
cp wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
~~~

`wrangler.jsonc` 已被 `.gitignore` 忽略。请不要提交真实 Token 或 Cloudflare 资源 ID。

### 2. 创建 KV 和 R2

~~~bash
pnpm exec wrangler kv namespace create snipflow-kv
pnpm exec wrangler r2 bucket create snipflow-r2
~~~

把命令输出的 KV namespace ID 和 R2 bucket 名称填入 `wrangler.jsonc`：

- `SNIPFLOW_KV.id`：KV namespace ID
- `SNIPFLOW_R2.bucket_name`：R2 bucket 名称
- `SNIPFLOW_API_TOKEN`：客户端调用 API 时使用的 Bearer Token
- `SNIPFLOW_MAX_SNIP_SIZE`：单个对象最大字节数，默认 10 MiB
- `SNIPFLOW_TOTAL_STORAGE_LIMIT`：`GET /stats` 返回的容量展示值，默认 100 MiB
- `SNIPFLOW_DISGUISE`：`true` 时把错误伪装成 `200 Hello World`，默认 `false`

建议使用足够长的随机 Token。`SNIPFLOW_TOTAL_STORAGE_LIMIT` 当前只用于统计响应，不会自动阻止总容量继续增长。

### 3. 校验并部署

~~~bash
pnpm cf-typegen
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm deploy
~~~

`pnpm deploy` 会执行 `wrangler deploy --minify`，并在终端输出 Worker URL。下文用环境变量表示该地址：

~~~bash
export SNIPFLOW_URL="https://你的-worker.workers.dev"
export SNIPFLOW_TOKEN="你的-token"
~~~

### 本地启动

~~~bash
pnpm dev
~~~

请以 Wrangler 启动日志中的地址为准。当前开发配置使用 `http://localhost:10001`；若复制的模板未设置 `dev.port`，Wrangler 会使用其默认端口。本地测试时可按实际地址设置：

~~~bash
export SNIPFLOW_URL="http://localhost:10001"
~~~

Wrangler 默认使用本地模拟的 KV/R2 数据，不会改动线上 bucket。

## 五分钟上手

### 健康与认证

`GET /health` 不需要认证：

~~~bash
curl "$SNIPFLOW_URL/health"
~~~

验证 Token：

~~~bash
curl \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  "$SNIPFLOW_URL/health/auth"
~~~

成功响应：

~~~json
{
  "ok": true,
  "authed": true
}
~~~

### 上传文件

`POST /snip` 的请求正文就是文件本身。必须提供 Bearer Token、真实 `Content-Type` 和 `X-Snip-Source`：

~~~bash
curl -X POST "$SNIPFLOW_URL/snip" \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  -H "Content-Type: application/pdf" \
  -H "X-Snip-Key: report-2026" \
  -H "X-Snip-Source: page" \
  -H "X-Snip-Filename: report.pdf" \
  --data-binary @report.pdf
~~~

成功返回 `201`：

~~~json
{
  "key": "report-2026",
  "contentType": "application/pdf",
  "filename": "report.pdf",
  "source": "page",
  "size": 12345,
  "createdAt": "2026-09-07T00:00:00.000Z",
  "expiresAt": null
}
~~~

省略 `X-Snip-Key` 时由服务端生成 key；请保存响应中的 `key`。

### 上传文本或 JSON

文本仍然使用相同接口，不需要 `type: "text"`：

~~~bash
curl -X POST "$SNIPFLOW_URL/snip" \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  -H "Content-Type: text/markdown; charset=utf-8" \
  -H "X-Snip-Source: page" \
  --data-binary '# Hello Snipflow'
~~~

JSON 也作为原始正文上传：

~~~bash
curl -X POST "$SNIPFLOW_URL/snip" \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Snip-Key: settings" \
  -H "X-Snip-Source: app" \
  --data-binary '{"theme":"dark"}'
~~~

### 下载对象

`GET /snip/:key` 直接返回原始对象，不返回 JSON 包装：

~~~bash
curl -fL \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  --output report.pdf \
  "$SNIPFLOW_URL/snip/report-2026"
~~~

Worker 会恢复上传时保存的 Content-Type、Content-Language、Content-Disposition、Content-Encoding、Cache-Control 和 Expires，并返回 ETag 与 Content-Length。

如果上传时提供了文件名但没有 Content-Disposition，Worker 会在响应中自动生成 RFC 5987 下载文件名。文本内容可省略 `--output` 直接查看。

### 列出对象

~~~bash
curl \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  "$SNIPFLOW_URL/snip"
~~~

响应最多包含 100 条索引，不加载对象正文：

~~~json
{
  "items": [
    {
      "key": "report-2026",
      "contentType": "application/pdf",
      "filename": "report.pdf",
      "size": 12345,
      "createdAt": "2026-09-07T00:00:00.000Z",
      "expiresAt": null
    }
  ],
  "cursor": "下一页游标"
}
~~~

响应存在 `cursor` 时，将它作为不透明字符串传入下一页；实际客户端应进行 URL 编码：

~~~bash
curl \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  "$SNIPFLOW_URL/snip?cursor=<URL-encoded-cursor>"
~~~

### 查看统计

~~~bash
curl \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  "$SNIPFLOW_URL/stats"
~~~

~~~json
{
  "count": 1,
  "totalSize": 12345,
  "storageLimit": 104857600
}
~~~

### 删除对象

~~~bash
curl -X DELETE \
  -H "Authorization: Bearer $SNIPFLOW_TOKEN" \
  "$SNIPFLOW_URL/snip/report-2026"
~~~

成功返回 `204 No Content`。

## 上传 Header 参考

### 控制 Header

| Header | 必填 | 说明 |
|---|---:|---|
| `Authorization` | 是 | `Bearer <token>` |
| `Content-Type` | 是 | 任意合法 MIME，可带参数 |
| `X-Snip-Source` | 是 | 来源标记，1–256 字符 |
| `X-Snip-Key` | 否 | 1–128 个字母、数字、`_`、`-`；缺省时自动生成 |
| `X-Snip-Filename` | 否 | 文件名，解码后 1–1024 字符 |
| `X-Snip-TTL` | 否 | 正整数秒；缺省表示永久保存 |
| `X-Snip-Overwrite` | 否 | `true` 或 `false`，默认 `false` |
| `X-Snip-Meta-*` | 否 | 额外的 R2 custom metadata |

已有 key 默认返回 `409 KEY_CONFLICT`。确认覆盖时添加：

~~~http
X-Snip-Overwrite: true
~~~

设置 24 小时 TTL：

~~~http
X-Snip-TTL: 86400
~~~

TTL 先让 KV 索引过期，使对象立即无法通过 API 读取；每小时运行的清理任务随后删除孤立 R2 对象。

浏览器 Header 不能直接承载任意 Unicode。非 ASCII 文件名建议先编码：

~~~js
headers.set('X-Snip-Filename', encodeURIComponent(file.name))
~~~

也可以直接发送标准 Content-Disposition；未提供 `X-Snip-Filename` 时，Worker 会从 `filename*` 或 `filename` 提取文件名。

### R2 HTTP metadata

以下标准请求头会映射到 R2 `httpMetadata`，并在下载时恢复：

| 请求 Header | R2 字段 |
|---|---|
| `Content-Type` | `contentType` |
| `Content-Language` | `contentLanguage` |
| `Content-Disposition` | `contentDisposition` |
| `Content-Encoding` | `contentEncoding` |
| `Cache-Control` | `cacheControl` |
| `Expires` | `cacheExpiry` |

`Expires` 是对象的 HTTP 缓存元数据，不会让 snip 自动失效。需要自动失效时使用 `X-Snip-TTL`。

### R2 custom metadata

`X-Snip-Source` 保存为 `source`，文件名保存为 `filename`。任何 `X-Snip-Meta-*` 请求头都会去掉前缀并保存为扩展 metadata：

~~~http
X-Snip-Meta-Category: finance
X-Snip-Meta-Owner: team-a
~~~

对应 R2 custom metadata：

~~~json
{
  "category": "finance",
  "owner": "team-a",
  "source": "page",
  "filename": "report.pdf"
}
~~~

custom metadata 的 key/value UTF-8 字节数合计最多 8192。Authorization、Cookie、Host、CF-*、Content-Length 和其他未显式允许的头不会保存。除 filename 用于生成下载头外，扩展 custom metadata 当前不会在公开 API 响应中返回。

## API 一览

| 方法 | 路径 | 认证 | 响应 |
|---|---|---:|---|
| GET | `/health` | 否 | 健康状态 JSON |
| GET | `/health/auth` | 是 | 认证状态 JSON |
| POST | `/snip` | 是 | 201，创建后的索引 JSON |
| GET | `/snip` | 是 | 分页索引 JSON |
| GET | `/snip/:key` | 是 | 原始对象正文和 HTTP metadata |
| DELETE | `/snip/:key` | 是 | 204 |
| GET | `/stats` | 是 | 存储统计 JSON |

## 错误处理

伪装模式关闭时，错误响应格式为：

~~~json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid input",
    "requestId": "request-id",
    "issues": []
  }
}
~~~

常见状态：

| 状态 | code | 常见原因 |
|---:|---|---|
| 400 | `INVALID_INPUT` | key、TTL、MIME、Expires 或 metadata 不合法 |
| 401 | `UNAUTHORIZED` | Token 缺失或错误 |
| 404 | `NOT_FOUND` | KV 索引或 R2 正文不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 使用了 GET/POST/DELETE 之外的方法 |
| 409 | `KEY_CONFLICT` | key 已存在且未允许覆盖 |
| 413 | `PAYLOAD_TOO_LARGE` | 对象超过 `SNIPFLOW_MAX_SNIP_SIZE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 缺少 Content-Type |
| 500 | `INTERNAL_ERROR` | 存储或配置异常 |

`SNIPFLOW_DISGUISE=true` 时，上述错误统一对外显示为 `200 Hello World`；排错时应查看 Worker 日志或临时关闭伪装模式。

## 从旧版升级

本次 API 是破坏性升级：

- 不再接受 `{ key, type, content, source, expiry }` 的 JSON 包装。
- 不再使用 `text`、`image`、`file` 三种类型。
- `GET /snip/:key` 不再返回包含 `content` 的 JSON，而是直接返回对象。
- 旧 KV 索引只有 `type`，缺少 `contentType` 和 `filename`，部署前必须迁移或清空旧 `snip:*` 数据。

R2 对象路径仍为 `snips/{key}/payload`。注意：如果直接清空 KV，而每小时 Cron 仍启用，现有 R2 对象会被判定为孤立对象并删除。迁移期间请暂停清理触发器，或先重建新的 KV 索引。

## 常用开发命令

~~~bash
pnpm dev
pnpm cf-typegen
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm test:coverage
pnpm deploy
~~~

需要理解存储模型、失败补偿、模块职责、测试策略或从空目录复刻当前项目时，请继续阅读 [architecture.md](./architecture.md)。
