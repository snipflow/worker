# Snipflow Worker 架构

## 1. 职责

worker 是 Snipflow 的统一后端服务。它接收来自 Pages 前端、Telegram Bot 以及未来其他客户端的授权请求，将原始请求体和对象元数据存入 Cloudflare R2，并将用于查询、TTL 和统计的索引元数据存入 Cloudflare KV。

第一版中，后端不将 page 和 bot-tg 视为独立的安全域。所有客户端使用相同的公开 API 结构和相同的服务端 Token 验证模型。`source` 字段仅作为记录来源的元数据，不作为权限控制依据。

## 2. 技术栈

| 层级 | 选型 |
|------|------|
| 运行时 | Cloudflare Workers |
| 语言 | TypeScript |
| 包管理器 | pnpm |
| 路由框架 | Hono |
| 数据校验 | Zod |
| 元数据存储 | Cloudflare KV |
| 负载存储 | Cloudflare R2 |
| 本地开发 / 部署 | Wrangler |
| 测试 | Vitest（Cloudflare Workers pool） |

## 3. 请求流程

~~~
HTTP 请求
  -> Request ID / Content-Length 预检 / 方法过滤
  -> Token 认证中间件（Bearer 校验）
  -> Content-Type 存在性检查
  -> 请求头、路径参数、查询参数校验（Zod）
  -> 资源路由（/snip、/stats）
  -> 服务层（业务逻辑）
  -> 仓储层（KV + R2 访问封装）
  -> 原始请求体流式写入 R2，索引写入 KV
  -> JSON 元数据响应或原始对象流响应
~~~

`POST /snip` 的请求体就是待存储对象，不经过 JSON 包装，也不转换为字符串。文本、图片、文档、自定义二进制和 JSON 都走同一条链路，由请求的 `Content-Type` 描述格式。

## 4. 守卫策略

守卫层是第一道后端边界，在请求进入业务逻辑之前拒绝无效请求。所有守卫逻辑作为 Hono 中间件挂载，按顺序执行，任一环节失败立即按伪装设置决定响应内容。

### 4.1 伪装模式

通过环境变量 `SNIPFLOW_DISGUISE=true` 开启伪装模式。开启后，所有未通过守卫的请求均返回 `200 OK` 的 Hello World 页面，不暴露任何错误信息；真实错误原因仅写入后端日志（`console.error`）。关闭时（默认），返回标准 JSON 错误结构。

伪装模式在全局错误处理器（`app.onError`）中统一实现，不在各个中间件中重复判断：

~~~ts
// domain/errors.ts 中的 handleError 函数
export function handleError(err: Error, c: Context) {
  const requestId = c.get('requestId')
  const disguise = c.env.SNIPFLOW_DISGUISE === 'true'

  if (err instanceof AppError) {
    if (disguise) {
      console.error(`[error] requestId=${requestId} code=${err.code} status=${err.status}`)
      return c.html('<html><body><h1>Hello World</h1></body></html>', 200)
    }
    return c.json({ error: { code: err.code, message: err.message, requestId } }, err.status)
  }
  // ...
}
~~~

### 4.2 守卫职责与 Hono 工具栈

| 职责 | 实现方式 |
|------|---------|
| 生成 / 透传 Request ID | [`hono/request-id`](https://hono.dev/docs/middleware/builtin/request-id) 内置中间件，通过 `c.get('requestId')` 获取，自动写入响应头 `X-Request-Id` |
| Bearer Token 认证 | [`hono/bearer-auth`](https://hono.dev/docs/middleware/builtin/bearer-auth) 内置中间件，通过 `invalidToken` / `noAuthenticationHeader` 回调抛出 `UnauthorizedError` |
| 请求体大小限制 | 自定义 `bodyLimitGuard` 读取 `SNIPFLOW_MAX_SNIP_SIZE`。有 `Content-Length` 时在写入前预检；无该头时在 R2 写入后以 `R2Object.size` 最终校验 |
| 方法过滤 | 自定义中间件，只允许 GET、POST、DELETE，其余方法抛出 `MethodNotAllowedError` |
| Content-Type 校验 | 自定义中间件要求 POST / PUT 带 `Content-Type`，不限制具体 MIME；MIME 语法随后由 Zod 校验 |
| 统一错误响应 | Hono `app.onError` 捕获所有 `AppError`，根据伪装模式返回 JSON 错误或 Hello World 页面 |

中间件挂载顺序与当前 `app.ts` 一致：

~~~ts
app.use('*', requestIdMiddleware)
app.use('*', bodyLimitGuard)
app.use('*', methodGuard)

app.get('/health', ...)
app.get('/health/auth', auth, ...)

app.use('/snip/*', auth)
app.use('/stats', auth)
app.use('/snip', contentTypeGuard)
~~~

请求体必须原样传给 R2。不能为了边读边计数而套一层普通 `TransformStream`，因为它会丢失 Workers 请求体携带的固定长度属性，R2 会以“stream must have a known length”拒绝写入。因此当前实现使用两级限制：

1. `Content-Length` 存在时提前拒绝超限请求。
2. R2 写入完成后按对象的实际 `size` 再校验；新建对象超限则删除，覆盖对象超限则恢复旧对象和全部 metadata。

### 4.3 错误码约定

| HTTP 状态 | code 字符串 | 含义 |
|-----------|------------|------|
| 400 | `INVALID_INPUT` | 请求头、路径参数或查询参数校验失败 |
| 401 | `UNAUTHORIZED` | Token 缺失或无效 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 不支持的 HTTP 方法 |
| 409 | `KEY_CONFLICT` | key 已存在，需显式允许覆盖 |
| 413 | `PAYLOAD_TOO_LARGE` | `Content-Length` 或 R2 实际对象大小超限 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 缺少 `Content-Type` |
| 500 | `INTERNAL_ERROR` | 服务内部错误 |

伪装模式开启时，以上所有状态码对外均呈现为 `200 Hello World`，错误码仅出现在日志中。

### 4.4 未来守卫扩展方向

- 按客户端独立 Token
- HMAC 请求签名
- 时间戳与 Nonce 重放防护
- 按 Token 限流（可使用 [`workers-hono-rate-limit`](https://github.com/elithrar/workers-hono-rate-limit) 基于 Cloudflare Rate Limiting API）
- 只读权限的受限 Token

## 5. API 接口

所有客户端使用统一的 `/snip` 路径，不引入版本前缀。路由负责解析并校验 HTTP 输入、构造 R2 metadata、调用服务层并映射响应，不承载 KV/R2 协调逻辑。

资源路由：

~~~
GET    /health              健康检查，无需认证
GET    /health/auth         带认证的握手检查
POST   /snip                创建或覆盖 snip
GET    /snip                分页列出 snip 索引
GET    /snip/:key           流式读取 R2 原始对象
DELETE /snip/:key           删除 KV 索引和 R2 对象
GET    /stats               查询存储统计
~~~

除 `GET /health` 外，上述 snip 与 stats 接口都要求 `Authorization: Bearer <token>`。`GET /health/auth` 用于客户端初始化时验证 Token。

API 边界约定：

- `POST /snip` 不解析 JSON；请求正文就是对象正文，控制参数和对象 metadata 全部来自请求头。
- 所有动态请求头、路径参数和查询参数在路由边界用 Zod 校验。
- KV JSON 属于持久化边界，反序列化后必须通过 `SnipMetaSchema`，禁止直接断言历史数据类型。
- JSON 响应通过显式 DTO 映射构造，禁止把含内部 `r2Key` 的 `SnipMeta` 直接展开。
- `GET /snip/:key` 是例外：它返回原始 R2 对象流和对象 HTTP metadata，不返回 JSON DTO。

`GET /stats` 响应：

~~~json
{
  "count": 42,
  "totalSize": 10485760,
  "storageLimit": 104857600
}
~~~

- `count`：R2 `meta/stats.json` 统计对象维护的 snip 数量。
- `totalSize`：同一 R2 统计对象维护的正文总字节数。
- `storageLimit`：`SNIPFLOW_TOTAL_STORAGE_LIMIT` 的静态配置值，不是从 R2 bucket 动态读取。
- 两个动态字段通过 ETag 条件写入在同一次 CAS 中原子更新，不再使用最终一致的 KV
  read-modify-write 计数器。

### 5.1 POST /snip — 创建或覆盖 snip

请求正文为待保存的原始字节，不再存在 `type`、`content` 或 `expiry` JSON 字段，也不区分 text、image、file 三种类别。

~~~http
POST /snip HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/pdf
Content-Language: zh-CN
Content-Disposition: attachment; filename="report.pdf"
Cache-Control: private, max-age=3600
Expires: Tue, 08 Sep 2026 00:00:00 GMT
X-Snip-Key: report-2026
X-Snip-Source: page
X-Snip-Filename: report.pdf
X-Snip-TTL: 86400
X-Snip-Overwrite: false
X-Snip-Meta-Category: finance

<PDF 原始字节>
~~~

控制头：

| Header | 必填 | 校验与语义 |
|------|------|------|
| `Authorization` | 是 | Bearer Token；只用于认证，绝不写入 metadata |
| `Content-Type` | 是 | 任意合法 MIME，可包含参数，例如 `text/markdown; charset=utf-8` |
| `X-Snip-Key` | 否 | 缺省或空值时生成 5 位随机 key；自定义值为 1–128 个 `[A-Za-z0-9_-]` 字符 |
| `X-Snip-Source` | 是 | 1–256 字符；仅作来源元数据，不参与授权 |
| `X-Snip-Filename` | 否 | 解码后 1–1024 字符；浏览器发送非 ASCII 文件名时先用 `encodeURIComponent` |
| `X-Snip-TTL` | 否 | 正整数秒；缺省表示永久可见 |
| `X-Snip-Overwrite` | 否 | 只能是 `true` / `false`，默认 `false` |
| `X-Snip-Meta-*` | 否 | 显式声明扩展 custom metadata；前缀后的名字作为 metadata key |

`X-Snip-Filename` 缺省时，Worker 依次尝试解析 `Content-Disposition` 的 `filename*=UTF-8''...`、引号形式 `filename="..."` 和普通 `filename=...`。

标准 HTTP metadata 映射：

| HTTP 请求头 | `R2HTTPMetadata` 字段 | 类型 |
|------|------|------|
| `Content-Type` | `contentType` | `string` |
| `Content-Language` | `contentLanguage` | `string` |
| `Content-Disposition` | `contentDisposition` | `string` |
| `Content-Encoding` | `contentEncoding` | `string` |
| `Cache-Control` | `cacheControl` | `string` |
| `Expires` | `cacheExpiry` | `Date` |

`Expires` 在 Schema 边界解析成 `Date`。这些字段与 HTTP 标准头有直接映射，但 `Content-Type` 的值不是项目枚举：只要 MIME 语法合法即可。Worker 不猜测文件类型，也不根据后缀重写 Content-Type。

custom metadata 映射：

| 请求头 | R2 `customMetadata` |
|------|------|
| `X-Snip-Source: page` | `source: "page"` |
| `X-Snip-Filename: report.pdf` | `filename: "report.pdf"` |
| `X-Snip-Meta-Category: finance` | `category: "finance"` |
| 其他 `X-Snip-Meta-*` | 前缀后的名称和值 |

请求头名称由 Fetch API 规范化，因此扩展 metadata key 按小写保存。`source` 和 `filename` 是规范字段，优先于同名 `X-Snip-Meta-*`。custom metadata 的 key/value UTF-8 字节数合计不得超过 8192；路由在调用 R2 前完成校验。

仅保存六个标准 HTTP metadata 头、`source`、`filename` 和显式的 `X-Snip-Meta-*`。`Authorization`、`Cookie`、`Host`、`CF-*`、`Content-Length` 等认证或传输头不会被复制。

TTL 仍由 KV 控制：`X-Snip-TTL` 存在时传给 KV `expirationTtl`，缺省时不设置过期。R2 不按单条 snip 的 KV TTL 自动删除；每小时运行的 Cron Trigger 扫描 `snips/`，删除已没有 `snip:{key}` KV 索引的孤立对象。

Schema 由 `CreateSnipHeadersSchema` 组成，主要使用：

| Zod 功能 | 用途 |
|------|------|
| `z.strictObject({...})` | 明确定义路由构造的请求头输入 |
| `z.union([z.literal(''), SnipKeySchema])` | 允许缺省 key，同时复用 URL-safe key 规则 |
| `z.enum(['true', 'false']).transform(...)` | 校验并转换 overwrite |
| `z.string().regex(...).transform(Number)` | 把 TTL 头转换成正整数秒 |
| `.refine(...)` | 验证 MIME 与 HTTP 日期 |
| `.safeParse()` | 把问题转换为 `400 INVALID_INPUT` 的 issues 列表 |

创建成功返回 JSON 索引信息：

~~~json
{
  "key": "report-2026",
  "contentType": "application/pdf",
  "filename": "report.pdf",
  "source": "page",
  "size": 12345,
  "createdAt": "2026-09-07T00:00:00.000Z",
  "expiresAt": "2026-09-08T00:00:00.000Z"
}
~~~

`key` 始终返回；`filename` 可能为 `null`，永久对象的 `expiresAt` 为 `null`。

### 5.2 GET /snip/:key — 读取 snip

响应直接流式返回 R2 原始正文，不再把内容放进 JSON：

~~~http
GET /snip/report-2026 HTTP/1.1
Authorization: Bearer <token>
~~~

Worker 对响应执行以下映射：

1. 调用 `R2ObjectBody.writeHttpMetadata(headers)` 恢复六个标准 HTTP metadata。
2. 写入 `ETag` 和 `Content-Length`。
3. 若 R2 没有 Content-Type，则用 KV 的 `contentType` 兜底。
4. 若有 `customMetadata.filename` 但没有 Content-Disposition，则生成 `attachment; filename*=UTF-8''...`。
5. 以 `new Response(payload.body, { headers })` 返回，不缓冲对象。

除 filename 的下载头用途外，其他 custom metadata 当前不暴露给下载响应；它们保留在 R2 对象上供后续能力使用。

### 5.3 GET /snip — 列出所有 snip

列表只读取 KV 索引，不加载 R2 正文。查询参数 `cursor` 可选，必须是上一页返回的非空不透明字符串；每页最多 100 条。

~~~json
{
  "items": [
    {
      "key": "report-2026",
      "contentType": "application/pdf",
      "filename": "report.pdf",
      "size": 12345,
      "createdAt": "2026-09-07T00:00:00.000Z",
      "expiresAt": "2026-09-08T00:00:00.000Z"
    }
  ],
  "cursor": "next-page-cursor"
}
~~~

列表项不含正文、`source`、custom metadata 或内部 `r2Key`。

### 5.4 输入 Schema 与响应 DTO 映射

| 接口 | 运行时输入 Schema | 输出 |
|------|-------------------|------|
| `POST /snip` | `CreateSnipHeadersSchema` | `CreateSnipResponse` JSON |
| `GET /snip` | `ListSnipsQuerySchema` | `ListSnipsResponse` JSON |
| `GET /snip/:key` | `SnipKeyParamsSchema` | 原始 `Response` 流 |
| `DELETE /snip/:key` | `SnipKeyParamsSchema` | 204，无正文 |
| `GET /stats` | 无动态输入 | `Stats` JSON |

运行时 Schema：

- `SnipKeySchema`：1–128 个 URL-safe 字符，只允许 `[A-Za-z0-9_-]`。
- `SnipKeyParamsSchema`：读取和删除路由的 `{ key }`。
- `ListSnipsQuerySchema`：`{ cursor?: string }`，拒绝空 cursor 和未知字段。
- `CreateSnipHeadersSchema`：创建控制头和六个 R2 HTTP metadata 字段。
- `SnipMetaSchema`：KV 内部持久化结构，只用于仓储边界。

响应 DTO：

- `CreateSnipResponse`：`key`、`contentType`、`filename`、`source`、`size`、`createdAt`、`expiresAt`。
- `ListSnipItem`：不含 `source`，其余为 `key`、`contentType`、`filename`、`size`、`createdAt`、`expiresAt`。
- `ListSnipsResponse`：`{ items, cursor? }`。
- `Stats`：`{ count, totalSize, storageLimit }`。

以上类型定义在 `domain/types.ts`。

## 7. 存储模型

索引与负载分开存储：KV 只负责分页索引和 TTL 可见性；R2 保存任意字节正文、
HTTP metadata、custom metadata 以及强一致统计对象。正文格式不再被压扁为项目内的三种类型。

### 7.1 KV 存储（索引元数据）

每个 snip 对应 `snip:{key}`，value 为 JSON。TTL 对象写入时附带 `expirationTtl`：

~~~ts
await env.SNIPFLOW_KV.put(
  `snip:${key}`,
  JSON.stringify(metadata),
  ttlSeconds ? { expirationTtl: ttlSeconds } : undefined
)
~~~

读取时必须处理非法 JSON 和不符合当前 Schema 的历史数据：

~~~ts
const raw = await env.SNIPFLOW_KV.get(`snip:${key}`)
if (!raw) return null

const parsed: unknown = JSON.parse(raw)
const result = SnipMetaSchema.safeParse(parsed)
if (!result.success) throw new InternalError('Invalid snip metadata in KV')
return result.data
~~~

列表与删除：

~~~ts
await env.SNIPFLOW_KV.list({ prefix: 'snip:', limit: 100, cursor })
await env.SNIPFLOW_KV.delete(`snip:${key}`)
~~~

KV 中的结构：

~~~json
{
  "key": "report-2026",
  "contentType": "application/pdf",
  "filename": "report.pdf",
  "source": "page",
  "size": 12345,
  "createdAt": "2026-09-07T00:00:00.000Z",
  "expiresAt": null,
  "r2Key": "snips/report-2026/payload"
}
~~~

`r2Key` 是内部定位字段，不进入公开 JSON。R2 的正文与对象 metadata 是事实来源；KV 只保留列表和业务判断需要的冗余字段。

### 7.2 R2 存储（正文和对象 metadata）

对象 key 保持为 `snips/{key}/payload`。仓储方法接受 R2 支持的通用正文类型：

~~~ts
export type SnipPayload =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob

await env.SNIPFLOW_R2.put(
  `snips/${key}/payload`,
  payload,
  {
    onlyIf: previousObject
      ? { etagMatches: previousObject.etag }
      : { etagDoesNotMatch: '*' },
    httpMetadata,
    customMetadata,
    storageClass,
  }
)
~~~

当前 HTTP 路由把 `Request.body` 直接传给 `put`。仓储同时保留 `storageClass` 参数，供覆盖回滚时原样恢复；`onlyIf` 由服务层内部使用，避免并发创建或覆盖同一 key。校验和、SSE-C 等其他 `R2PutOptions` 尚未开放为公共 API。

读取必须保留流和 metadata：

~~~ts
const object = await env.SNIPFLOW_R2.get(`snips/${key}/payload`)
if (!object) throw new NotFoundError()
return new Response(object.body, { headers })
~~~

禁止在通用读取路径调用 `text()` 或 `arrayBuffer()` 缓冲整个对象。返回响应前使用 `writeHttpMetadata` 恢复标准头，并单独写入 `httpEtag` 与对象大小。

### 7.3 R2 原子统计对象

`count` 与 `totalSize` 不再拆成两个 KV key，而是共同存储在
`meta/stats.json`：

~~~json
{
  "count": 42,
  "totalSize": 10485760
}
~~~

`repositories/r2-stats.ts` 以 R2 强一致读和 ETag 条件写入实现 CAS：

1. 读取当前统计对象和 ETag；对象不存在时以 `{ count: 0, totalSize: 0 }` 为基线。
2. 在内存中同时应用 count 与 totalSize delta，并拒绝负数、非整数或非安全值。
3. 已存在对象使用 `etagMatches`，首次创建使用 `etagDoesNotMatch: '*'`。
4. 条件失败返回 `null`，重新读取最新版并重试，最多 16 次。
5. 两个字段写入同一个 JSON 对象，因此单次增减不会只成功一半。

R2 没有原生 increment 指令；这里的“原子增减”指基于 ETag 的乐观并发控制。
同一对象 key 的写入吞吐仍受 R2 平台限制，因此该方案适合当前低写入量服务，
不应作为高频全局计数器使用。

统计对象不在 `snips/` 前缀下，不会被 payload 列表或孤儿清理误处理。
`GET /stats` 在对象缺失时返回零值；从旧版本升级且已有 payload 时，必须先按现存
`snips/*/payload` 对象的数量和 size 创建该对象，旧 KV
`meta:count`/`meta:totalSize` 不再读取。

### 7.4 创建、覆盖与删除的一致性

KV 和 R2 没有跨产品事务，服务层通过 R2 条件写入、原子统计 CAS、写入顺序和补偿
回滚降低不一致风险。

创建或覆盖：

1. 解析 key，读取旧 KV 元数据。
2. 覆盖时读取旧 `R2ObjectBody`，保留正文流、`httpMetadata`、`customMetadata` 和 `storageClass`。
3. 新建使用 `etagDoesNotMatch: '*'`，覆盖使用旧 ETag 的 `etagMatches` 条件写入；并发输家返回冲突，不执行回滚或计数。
4. 按 R2 返回的实际 `size` 校验上限。
5. 写 KV 索引及 TTL。
6. 通过单次 R2 CAS 同时应用 count 和 totalSize 差值。

第 3–6 步失败时：

- 新建对象：删除已写入的 R2 对象。
- 覆盖对象：用旧正文和全部对象 metadata 恢复原对象。
- KV 已写入时，同时恢复旧 KV metadata；原对象带 TTL 时按剩余时间恢复。
- 回滚本身失败：抛出同时包含原始错误与回滚错误的 `AggregateError`。

删除先原子递减统计，再删除 KV metadata 和 R2 payload；任一删除失败时恢复已删除的
metadata，并通过反向 CAS 恢复统计。KV 先到期形成的孤立 R2 对象由 Cron 按实际
R2 size 汇总递减统计后批量删除；批量删除失败时同样反向恢复统计。

## 8. 内部分层

所有环境变量和 binding 在 `wrangler.jsonc` 中声明，`wrangler types --env-interface CloudflareBindings` 生成 `worker-configuration.d.ts`。仓库提供 `wrangler.jsonc.example`；实际 `wrangler.jsonc`、生成类型和本地密钥文件不提交版本库。

目录结构：

~~~
src/
  index.ts                  Worker fetch / scheduled 入口
  app.ts                    Hono app、中间件与路由注册

  routes/
    snip.ts                 请求头映射、原始 body 传递、下载响应
    stats.ts                GET /stats

  middleware/
    request-id.ts           Request ID 注入
    guard.ts                方法白名单、Content-Length 预检、大小配置校验
    auth.ts                 Bearer Token 认证
    content-type.ts         写请求必须声明 Content-Type

  schemas/
    snip.ts                 创建头、key、path params、list query Schema

  services/
    snip/
      create.ts             冲突、R2/KV 写入、实际大小校验、补偿回滚
      list.ts               KV 分页列表
      read.ts               联合读取 KV 与 R2ObjectBody
      delete.ts             原子统计递减、删除与失败补偿
    stats.ts                存储统计

  repositories/
    kv.ts                   KV 索引 CRUD、分页、持久化 Schema 边界
    r2-payload.ts           payload 正文和对象 metadata 的 CRUD / list
    r2-stats.ts             R2 统计对象校验、ETag CAS 与原子增减

  domain/
    types.ts                Payload、SnipMeta、服务输入和公开 DTO
    errors.ts               AppError 体系和统一错误响应

  utils/
    key.ts                  nanoid 随机 key
    time.ts                 TTL 与 ISO 时间
    r2-metadata.ts          文件名、custom metadata 白名单与下载头

  jobs/
    cleanup.ts              分页清理 R2 孤立对象
~~~

为什么 services 按操作拆分文件：snip 的增删查彼此独立，依赖的仓储方法不同，拆分后每个文件职责单一，测试可以直接调用服务而不构造 Hono Context。

各层职责：

| 层级 | 职责 |
|------|------|
| routes | 校验 HTTP 边界，映射 R2 metadata，传递原始流，构造公开响应 |
| middleware | Request ID、认证、方法、Content-Type 和大小预检 |
| schemas | 用 Zod 校验所有外部动态字符串以及 KV 持久化数据 |
| services | 业务规则和 KV/R2 协调，不依赖 Hono |
| repositories | 封装绑定 API，保留 R2 流和对象 metadata |
| domain | 稳定领域输入、持久化类型、公开 DTO 和错误 |
| utils | 无副作用的 key、时间和 metadata 工具 |
| jobs | Scheduled handler 调用的孤立对象清理 |

## 9. 解耦原则

- 路由处理器不直接访问 KV 或 R2，只通过服务层操作。
- 服务层不依赖 Hono Context，只接收 binding 与领域输入。
- 仓储层不感知请求来源或 MIME，只负责 KV / R2 的通用读写。
- `source` 是 metadata，不作为权限边界。
- 内容类型由标准 `Content-Type` 表达；新增 MIME 无需修改 Schema 枚举或服务映射。
- 只有显式 `X-Snip-Meta-*` 才进入扩展 custom metadata，避免保存敏感或无关请求头。
- 新客户端复用 `/snip`，不引入客户端专属路由。
- 大对象读写保持流式，不在 route/service/repository 任一层转成完整字符串或缓冲区。

## 10. 测试策略

使用 Vitest + `@cloudflare/vitest-pool-workers`，在 Workers 运行时和真实 KV/R2 测试 binding 中执行，不用手写存储 mock。

覆盖率使用 `@vitest/coverage-istanbul`；Workers 测试池不支持原生 V8 覆盖率。
门禁为 statements 90%、branches 80%、functions 95%、lines 90%，
`pnpm test:coverage` 未达到任一阈值即失败。

测试分层：

| 层级 | 覆盖目标 |
|------|------|
| repositories | KV Schema 边界、对象路径、任意字节、完整 R2 metadata、分页和空值 |
| schemas | header、MIME、TTL、overwrite、HTTP 日期、key 与 cursor 边界 |
| utils | 文件名解析、UTF-8 编码、metadata 白名单与 8192 字节计算 |
| services | 生成 key、R2 条件冲突、覆盖、TTL、实际大小、原子统计与补偿回滚 |
| routes | 原始 HTTP body、标准/自定义 metadata、流式下载、错误与完整生命周期 |
| jobs | 分页扫描，只删除没有 KV 索引的 `snips/` 对象 |

关键用例：

_repositories/kv_

- 合法 `SnipMeta` 往返一致。
- 非法 JSON、旧 `type` 结构或缺失 `contentType` 的数据抛出 `InternalError`。
- TTL、删除和分页行为正确；KV 不再保存统计计数器。

_repositories/r2_
_repositories/r2-stats_

- 统计对象缺失时返回零值。
- count 与 totalSize 在同一次 ETag CAS 中更新。
- 并发更新发生条件冲突时重试，最终不丢增量。
- 拒绝负数、非整数、非法 JSON 和不符合 Schema 的历史值。

- 字符串与二进制逐字节往返。
- `httpMetadata` 与 `customMetadata` 可写入并读取。
- delete 后返回 null；list 只返回 `snips/` 前缀。

_schemas 与 utils_

- 条件创建/覆盖同一 key 时只有一个并发写入者成功。
- 接受标准和 vendor MIME，拒绝缺少斜线等非法值。
- 接受缺省 key，拒绝带斜线、空格或超过 128 字符的 key。
- TTL 只接受正整数字符串；overwrite 只接受 true/false。
- `Expires` 转成 Date，非法日期失败。
- 从 `X-Snip-Filename` 与三种 Content-Disposition filename 形式提取名称。
- UTF-8 custom metadata 按字节计数。
- Authorization、Cookie、Host、CF-* 不进入 custom metadata。

_services/snip/create_

- 缺省 key 生成非空且不冲突的随机值，最多尝试 3 次。
- 已存在 key 且 overwrite=false 返回 `KeyConflictError`。
- 任意 payload 和完整 metadata 被原样传给 R2。
- 以 R2 实际 size 写 KV 与 stats。
- 并发创建同一 key 只有一个成功且只计数一次。
- stats 更新失败时恢复 payload 与 KV metadata，包括旧 TTL。
- 超限新建删除 R2；超限覆盖恢复旧正文、HTTP metadata、custom metadata 与 storageClass。
- TTL 对象写入 expiresAt 与 KV expirationTtl。

_routes_

- Content-Type 可为 `text/markdown`、`application/pdf` 或 vendor MIME。
- 原始二进制 `POST` → `GET` 后字节完全一致。
- 六个标准 metadata 头写入 R2并在下载时恢复。
- filename 在缺少 Content-Disposition 时生成 RFC 5987 下载头。
- custom metadata 仅接收 `X-Snip-Meta-*`。
- 列表不返回正文、source、custom metadata 或 `r2Key`。
- 401、400、409、HTTP 层 413、415、404 与伪装模式行为正确。

_jobs/cleanup_

- R2 有对象且 KV 有索引：保留。
- R2 有对象但 KV 无索引：删除。
- 不属于 `snips/` 前缀的 R2 对象不处理。

- 删除孤儿前按对象实际 size 原子递减 R2 统计。
- 批量删除失败时反向恢复统计。
## 11. Roadmap

以下步骤以空目录为起点，按顺序可以复刻当前项目。每个阶段都给出可独立验证的验收点；实现细节以本文件前述类型、Schema、存储顺序和 API 契约为准。

---

### 阶段一：项目骨架与最小可跑通状态

目标：Worker 可以启动并响应 `/health`，本地工具链和 Cloudflare binding 类型就位。

实现步骤：

1. 初始化 ESM TypeScript 项目，使用 pnpm；安装运行依赖 `hono`、`nanoid`、`zod`，开发依赖 `wrangler`、`typescript-eslint`、`vitest`、`@cloudflare/vitest-pool-workers`、`@cloudflare/workers-types` 和与 Vitest 同版本的 `@vitest/coverage-istanbul`。
2. 添加与当前仓库一致的 scripts：`dev`、`deploy`、`cf-typegen`、`lint`、`test`、`test:watch`、`test:coverage`。
3. 创建严格模式 `tsconfig.json`、ESLint 配置和 `vitest.config.ts`；Vitest 指向 `./wrangler.jsonc`。
4. 创建 `wrangler.jsonc.example`，声明 `main: "src/index.ts"`、`SNIPFLOW_KV`、`SNIPFLOW_R2`、每小时 Cron、`SNIPFLOW_API_TOKEN` 的 Secrets Store binding，以及三个非敏感变量：`SNIPFLOW_TOTAL_STORAGE_LIMIT`、`SNIPFLOW_MAX_SNIP_SIZE`、`SNIPFLOW_DISGUISE`。
5. 复制为不提交的 `wrangler.jsonc`，填入 KV namespace ID、R2 bucket 名称和 Secrets Store ID；使用不带 `--remote` 的 Secrets Store 命令创建本地开发 Token，并在本地工作配置的 `dev` 中设置端口 10001、IP `0.0.0.0`；运行 `pnpm cf-typegen` 生成 `CloudflareBindings`。
6. 编写 `src/index.ts` 导出 Hono fetch handler，编写 `src/app.ts` 注册 `GET /health` 返回 `{ "ok": true }`。

验收：

~~~
pnpm exec tsc --noEmit
pnpm dev
GET /health -> 200 {"ok":true}
~~~

---

### 阶段二：错误与中间件层

目标：所有请求在路由前经过一致的守卫，错误结构统一。

实现步骤：

7. 在 `domain/errors.ts` 建立 `AppError`、401/404/400/405/409/413/415/500 子类和 `handleError`，实现伪装模式。
8. 在 `middleware/request-id.ts` 挂载 `hono/request-id`。
9. 在 `middleware/guard.ts` 实现 GET/POST/DELETE 白名单、`SNIPFLOW_MAX_SNIP_SIZE` 正整数配置校验，以及 POST 的 `Content-Length` 预检。
10. 在 `middleware/content-type.ts` 要求 POST/PUT 存在 Content-Type，不限定 MIME。
11. 在 `middleware/auth.ts` 使用 `hono/bearer-auth` 异步读取 `SNIPFLOW_API_TOKEN` 的 Secrets Store binding，并用 constant-time 比较校验 Bearer Token。
12. 添加 `GET /health/auth`，并严格按 4.2 节顺序挂载中间件。

验收：

~~~
GET  /health           无 Token -> 200
GET  /health/auth      无 Token -> 401
GET  /health/auth      正确 Token -> 200
POST /snip             无 Content-Type -> 415
POST /snip             Content-Length 超配置 -> 413
PUT  /health           -> 405
所有响应包含 X-Request-Id
~~~

---

### 阶段三：领域类型、工具与仓储层

目标：建立类型和底层存储边界，不加入 Hono 业务逻辑。

实现步骤：

13. 在 `domain/types.ts` 定义 `SnipExpiry`、`SnipPayload`、`CreateSnipInput`、`SnipMeta`、`CreateSnipResponse`、`ListSnipItem`、`ListSnipsResponse` 和 `Stats`。
14. 在 `utils/key.ts` 用 nanoid 的 62 字符字母表生成 5 位 key；在 `utils/time.ts` 实现当前时间和 TTL 到 ISO 时间转换。
15. 新建 `utils/r2-metadata.ts`：解析 X-Snip-Filename、解析 Content-Disposition、从 `X-Snip-Meta-*` 构造白名单 custom metadata、按 UTF-8 统计大小、生成 RFC 5987 Content-Disposition。
16. 在 `repositories/kv.ts` 实现 `getSnip`、`keyExists`、`putSnip`、`deleteSnip` 和 `listSnips`；所有 JSON 读取通过 `SnipMetaSchema`，不在 KV 中维护计数器。
17. 在 `repositories/r2-payload.ts` 实现 payload CRUD、条件 put、批量 delete 和带 size 的 list；在 `repositories/r2-stats.ts` 实现单对象统计 Schema、ETag CAS 和最多 16 次冲突重试。

验收：

~~~
KV metadata 合法 -> 完整往返
KV metadata 非法 -> InternalError
R2 二进制 + HTTP/custom metadata -> 完整往返
R2 get -> 保留 ReadableStream
KV/R2 list -> 只返回各自约定前缀
~~~

---

### 阶段四：Schema 校验层

目标：所有 HTTP 动态输入在进入服务前完成校验。

实现步骤：

18. 实现 `SnipKeySchema`、`SnipKeyParamsSchema` 和严格的 `ListSnipsQuerySchema`。
19. 实现 `CreateSnipHeadersSchema`：key 允许空值；source 1–256；filename 1–1024；TTL 是正整数字符串；overwrite 是 true/false；Content-Type 是合法 MIME；Expires 是可解析的 HTTP 日期；其余五个 HTTP metadata 值非空。
20. 为每个边界值编写 safeParse 单元测试，不再创建 JSON body Schema，也不再定义 type 枚举。

验收：

~~~
任意合法 MIME -> success: true
非法 MIME / TTL / overwrite / Expires -> success: false
key="" -> success: true
非法 path key / 空 cursor / 未知 query -> success: false
~~~

---

### 阶段五：服务层

目标：编码纯业务规则，协调 KV/R2 并实现失败补偿。

实现步骤：

21. 在 `services/snip/create.ts` 实现 key 解析和最多 3 次碰撞重试；overwrite=false 时先返回冲突。
22. 覆盖前读取旧 KV 与 R2；将原始 payload、httpMetadata、customMetadata 写 R2，以返回的实际 size 校验上限并构造 KV `SnipMeta`。
23. 按 7.4 节用 R2 ETag 条件创建/覆盖 payload；失败时回滚 R2 与 KV；成功后通过一次 CAS 同时应用 count/totalSize 差值。
24. 实现 `read.ts` 返回 `{ meta, payload: R2ObjectBody }`，`list.ts` 做 KV 分页并过滤 TTL 期间消失的条目，`delete.ts` 先原子递减统计再删除 KV/R2，失败时补偿。
25. 实现 `services/stats.ts`，从 R2 统计对象读取动态值，并对 storage limit 做非负整数校验。

验收：

~~~
create arbitrary bytes -> R2/KV metadata 正确
overwrite=false 冲突 -> 409
overwrite=true -> count 不变、totalSize 按差值更新
超限新建 -> 新 R2 对象已删除
超限覆盖 -> 旧对象和全部 metadata 已恢复
TTL / forever -> KV expiration 与 expiresAt 正确
~~~

---

### 阶段六：路由层

目标：把服务能力暴露为当前 HTTP API，保持上传和下载流式。

实现步骤：

26. 在 `routes/snip.ts` 的 POST handler 中读取原始 Headers，以 `CreateSnipHeadersSchema` 校验；构造六个字段的 `R2HTTPMetadata` 和白名单 `customMetadata`；校验 8192 字节后把 `c.req.raw.body` 原样传给 create service。
27. POST 只返回显式 `CreateSnipResponse`；list 只返回显式 `ListSnipItem`，不展开 `SnipMeta`。
28. GET `/:key` 读取 `R2ObjectBody`，用 `writeHttpMetadata`、`httpEtag`、`size` 和 filename 生成头，再直接返回 `payload.body`。
29. 实现 DELETE、list cursor 和 stats 路由，在 `app.ts` 注册全部 router。

验收：

~~~
POST arbitrary binary -> 201 JSON metadata
GET  /snip/:key -> 原始字节 + 正确 HTTP metadata
GET  /snip -> 不含正文/source/r2Key
DELETE /snip/:key -> 204
GET  /stats -> count/totalSize/storageLimit
create -> read -> list -> delete 生命周期通过
~~~

---

### 阶段七：定时清理任务

目标：回收 KV 已过期或删除后残留的 R2 对象。

实现步骤：

30. 在 `jobs/cleanup.ts` 按 cursor 分页 list `snips/`，并行检查对应 KV key；按孤儿对象实际 size 原子递减统计后批量删除，失败时反向恢复统计。
31. 在 `index.ts` 导出 `scheduled` handler，记录结构化成功/失败日志；在 Wrangler 配置中添加 `"0 * * * *"`。

验收：

~~~
有 KV 索引的 R2 对象 -> 保留
无 KV 索引的 R2 对象 -> 删除并同步递减统计
其他前缀对象 -> 不处理
pnpm exec wrangler dev --test-scheduled
GET /__scheduled -> 执行任务
~~~

---

### 阶段八：全量验证与部署

目标：在真实 Cloudflare 环境复现本地通过的完整链路。

实现步骤：

32. 运行 `pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm test`、`pnpm test:coverage` 和 `git diff --check`。
33. 登录 Cloudflare，创建 KV namespace 与 R2 bucket，把返回的 ID/名称填入 `wrangler.jsonc`，确认 binding 名严格为 `SNIPFLOW_KV` 和 `SNIPFLOW_R2`。
34. 设置生产 Token 与三个非敏感变量，运行 `pnpm cf-typegen` 和 `pnpm deploy`。
35. 按 README 的 curl 示例在线验证健康、认证、任意 MIME 上传、原始下载、列表、统计、删除和 TTL 清理。

上线前兼容性检查：

- 旧客户端发送的 `{ key, type, content, source, expiry }` JSON 包装不再接受，必须改成“原始 body + 请求头”。
- `GET /snip/:key` 从 JSON 改为原始对象响应，调用方必须按 Content-Type/Content-Disposition 处理。
- 旧 KV 数据包含 `type` 而没有 `contentType`、`filename`，新 `SnipMetaSchema` 会拒绝；部署前迁移或清空旧 `snip:*` 索引。
- R2 路径 `snips/{key}/payload` 未改变，bucket 对象本身无需搬迁，但若清空 KV 索引，Cron 会把对应 R2 对象视为孤立对象；迁移完成前应暂停清理触发器。
- 旧 KV `meta:count`/`meta:totalSize` 不再读取；如果已有 payload，部署前按
  `snips/*/payload` 的对象数量和 size 创建 R2 `meta/stats.json`。全新或空 bucket
  无需迁移，首次创建会从零值原子初始化。

线上验收：

~~~
GET  /health -> 200
GET  /health/auth（正确 Token）-> 200
POST /snip（任意 MIME + TTL + custom metadata）-> 201
GET  /snip/:key -> 字节、Content-Type、文件名一致
GET  /snip -> contentType / filename / size 正确
GET  /stats -> count / totalSize / storageLimit 正确
DELETE /snip/:key -> 204，随后 GET -> 404
Cron -> 只清理孤立 R2 对象
~~~
