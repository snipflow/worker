# Snipflow Worker 架构

## 1. 职责

worker 是 Snipflow 的统一后端服务。它接收来自 Pages 前端、Telegram Bot 以及未来其他客户端的授权请求，对 snip 数据进行规范化处理，并将元数据存入 Cloudflare KV、内容负载存入 Cloudflare R2。

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

```
请求
  -> 守卫中间件（方法过滤 / 体积限制 / Request ID）
  -> Token 认证中间件（Bearer 校验）
  -> Schema 校验（Zod）
  -> 资源路由（/snip、/stats）
  -> 服务层（业务逻辑）
  -> 仓储层（KV + R2 访问封装）
  -> Cloudflare KV / R2
  -> JSON 响应
```

## 4. 守卫策略

守卫层是第一道后端边界，在请求进入业务逻辑之前拒绝无效请求。所有守卫逻辑作为 Hono 中间件挂载，按顺序执行，任一环节失败立即按伪装设置决定响应内容。

### 4.1 伪装模式

通过环境变量 `SNIPFLOW_DISGUISE=true` 开启伪装模式。开启后，所有未通过守卫的请求均返回 `200 OK` 的 Hello World 页面，不暴露任何错误信息；真实错误原因仅写入后端日志（`console.error`）。关闭时（默认），返回标准 JSON 错误结构。

伪装模式在全局错误处理器 (`app.onError`) 中统一实现，不在各个中间件中重复判断：

```ts
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
```

### 4.2 守卫职责与 Hono 工具栈

每项守卫职责均有对应的 Hono 内置中间件或三方包，优先使用现有实现，不重复造轮子：

| 职责 | 实现方式 |
|------|---------|
| 生成 / 透传 Request ID | [`hono/request-id`](https://hono.dev/docs/middleware/builtin/request-id) 内置中间件，通过 `c.get('requestId')` 获取，自动写入响应头 `X-Request-Id` |
| Bearer Token 认证 | [`hono/bearer-auth`](https://hono.dev/docs/middleware/builtin/bearer-auth) 内置中间件，支持 `verifyToken` 自定义校验逻辑，通过 `invalidToken` / `noAuthenticationHeader` 回调抛出 `UnauthorizedError` |
| 请求体大小限制 | [`hono/body-limit`](https://hono.dev/docs/middleware/builtin/body-limit) 内置中间件，`maxSize` 硬编码为 100 MB（Cloudflare Workers Free 计划的平台硬限制），`onError` 回调抛出 `PayloadTooLargeError`。单个 snip 的 `content` 字段大小由环境变量 `SNIPFLOW_MAX_SNIP_SIZE` 限制（默认 10 MB），在 Schema 层通过 Zod 校验 |
| 方法过滤 | 自定义中间件，检查 `c.req.method` 是否在白名单内（GET/POST/DELETE），不在则抛出 `MethodNotAllowedError` |
| Content-Type 校验 | 自定义中间件，仅对 POST / PUT 请求校验 `application/json`，不匹配则抛出 `UnsupportedMediaTypeError` |
| 统一 JSON 错误响应 | Hono `app.onError` 全局错误处理器，捕获所有 `AppError` 子类，根据伪装模式返回 JSON 错误或 Hello World 页面 |

**中间件挂载顺序：**

```ts
app.use('*', requestId())           // 1. 先生成 Request ID，后续日志都能带上
app.use('*', bodyLimit({ maxSize: 100 * 1024 * 1024, onError: () => { throw new PayloadTooLargeError() } }))
app.use('*', methodGuard)           // 3. 方法过滤
app.use('/snip/*', createAuthMiddleware(c.env))
app.use('/stats', createAuthMiddleware(c.env))
app.use('/snip', contentTypeGuard)  // 6. 仅 POST 请求校验
```

### 4.3 错误码约定

| HTTP 状态 | code 字符串 | 含义 |
|-----------|------------|------|
| 400 | `INVALID_INPUT` | 请求体校验失败 |
| 401 | `UNAUTHORIZED` | Token 缺失或无效 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 不支持的 HTTP 方法 |
| 409 | `KEY_CONFLICT` | key 已存在，需确认后使用 overwrite 参数 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超限 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type 不支持 |
| 500 | `INTERNAL_ERROR` | 服务内部错误 |

伪装模式开启时，以上所有状态码对外均呈现为 `200 Hello World`，错误码仅出现在日志中。

### 4.4 未来守卫扩展方向

- 按客户端独立 Token
- HMAC 请求签名
- 时间戳与 Nonce 重放防护
- 按 Token 限流（可使用 [`workers-hono-rate-limit`](https://github.com/elithrar/workers-hono-rate-limit) 基于 Cloudflare Rate Limiting API）
- 只读权限的受限 Token

## 5. API 接口

所有客户端使用统一的 `/snip` 路径，不引入版本前缀。路由职责仅限于解析请求参数、调用服务层、返回响应，不包含任何业务逻辑。

**资源路由：**

```
GET    /health              健康检查，无需认证
GET    /health/auth         带认证的握手检查，验证 Token 是否有效
POST   /snip                创建 snip
GET    /snip                列出所有 snip（返回元数据列表）
GET    /snip/:key           读取单个 snip（元数据 + 负载内容）
DELETE /snip/:key           删除 snip（同时删除 KV 条目和 R2 对象）
GET    /stats               查询存储统计信息
```

`GET /health` 无需认证，用于基础存活探测。`GET /health/auth` 要求携带 Bearer Token，前端可在初始化时调用此接口验证 Token 是否配置正确，响应 200 表示认证通过，401 表示 Token 无效。

**`GET /stats` 响应示例：**

```json
{
  "count": 42,
  "totalSize": 10485760,
  "storageLimit": 104857600
}
```

- `count`：当前存储的 snip 数量，通过 KV 维护独立计数器键实现 O(1) 查询
- `totalSize`：所有 snip 负载的累计字节数，同样通过 KV 计数器维护
- `storageLimit`：全局容量上限，由环境变量 `SNIPFLOW_TOTAL_STORAGE_LIMIT`（字节数）静态配置，不依赖 R2 存储桶 API

### 5.1 POST /snip — 创建 snip

创建请求支持多种内容类型，通过 `type` 字段区分。**所有字段均为必填**，`key` 置空字符串 `""` 时由服务端生成随机 ID，`expiry.mode` 为 `"forever"` 表示永久保存。

**请求体：**

```json
{
  "key": "my-note",
  "type": "text",
  "content": "hello world",
  "source": "page",
  "expiry": {
    "mode": "ttl",
    "ttl": 86400
  },
  "overwrite": false
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 用户自定义查询键，接收方凭此键精确取回内容。传空字符串 `""` 时由服务端生成随机 key |
| `type` | `string` | 内容类型，见下表，Zod `z.enum` 严格枚举校验 |
| `content` | `string` | 实际内容，不得为空字符串 |
| `source` | `string` | 来源标记（`page` / `bot-tg` 等），仅作元数据记录 |
| `expiry` | `object` | 时效策略，见下表 |
| `overwrite` | `boolean`（可选） | 默认 `false`。为 `true` 时强制覆盖已存在的 key，为 `false` 时 key 冲突返回 `409 KEY_CONFLICT` |

**时效策略（`expiry` 字段）：**

| mode | 额外参数 | 实现方式 | 说明 |
|------|---------|---------|------|
| `"forever"` | — | KV 不设过期，R2 对象永久保留 | 由用户主动调用 DELETE 删除 |
| `"ttl"` | `ttl`（秒，正整数） | KV `expirationTtl`，孤立 R2 对象由清理任务回收 | 到达指定秒数后自动过期 |
| `"once"`（未来） | `count`（次数） | 读取时递减计数，归零后触发删除 | 取出 N 次后自动删除 |

**R2 孤立对象清理方案：**

R2 不支持对单个对象设置过期时间，[生命周期规则](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)只能在 bucket 级别按前缀配置，无法精确匹配每个 snip 的独立 TTL。因此采用以下策略：

KV 的 `expirationTtl` 控制元数据过期，元数据消失后该 snip 对外立即不可见。R2 侧的孤立对象（KV 已过期但 R2 对象仍存在）通过 **[Workers Cron Trigger](https://developers.cloudflare.com/workers/examples/cron-trigger/)** 定期清理：

```ts
// wrangler.jsonc 中配置定时任务，每小时执行一次
// "triggers": { "crons": ["0 * * * *"] }

export default {
  async scheduled(event, env, ctx) {
    // 1. list 所有 R2 对象（前缀 snips/）
    const listed = await env.SNIPFLOW_R2.list({ prefix: 'snips/' })
    for (const obj of listed.objects) {
      // 2. 从 R2 key 中提取 snip key（格式：snips/{key}/payload）
      const snipKey = obj.key.split('/')[1]
      // 3. 查询 KV，找不到元数据说明已过期或已被删除
      const meta = await env.SNIPFLOW_KV.get(`snip:${snipKey}`)
      if (!meta) {
        await env.SNIPFLOW_R2.delete(obj.key)
      }
    }
  }
}
```

此方案完全在 Workers 平台内部运作，无需外部服务，清理粒度与 KV TTL 精确对应。

**内容类型（`type` 字段）：**

R2 可存储任意格式的数据（`put()` 接受 `string | ArrayBuffer | ReadableStream | Blob`），`type` 字段的作用是让客户端正确解释内容，而非限制 R2 的存储能力。按内容格式分类，大部分文本归入 `text`：

| type | 适用内容 | R2 写入时的 contentType |
|------|---------|----------------------|
| `"text"` | 纯文本、Markdown、代码片段、URL、JSON 字符串等一切文本 | `text/plain` |
| `"image"` | PNG、JPEG、WebP、GIF 等图片 | `image/png` 等 |
| `"file"` | 二进制文件、文档等其他格式 | `application/octet-stream` |

Zod 使用 `z.enum(["text", "image", "file"])` 做枚举校验，非法值返回明确错误信息。

**Zod 校验方案：**

使用以下 Zod 功能，均有[官方文档](https://zod.dev)依据：

| Zod 功能 | 用途 |
|---------|------|
| `z.object({...})` | 定义请求体结构，所有字段默认必填 |
| `z.string().min(1, "不得为空")` | 校验 `content`、`source` 等字符串字段非空 |
| `z.string()` | 校验 `key`，允许空字符串（服务端据此决定是否生成随机 ID） |
| `z.enum([...])` | 校验 `type` 为枚举值，非法值自动报错 |
| `z.discriminatedUnion("mode", [...])` | 按 `expiry.mode` 分支校验：`ttl` 模式必须包含正整数 `ttl`，`forever` 模式不得有多余字段 |
| `z.number().int().positive()` | 校验 `ttl` 为正整数秒数 |
| `.safeParse()` | 返回 `{ success, data, error }` 结构，校验失败时将 `error.issues` 格式化后以 `INVALID_INPUT` 错误码返回 400 |

**校验示例：**

```ts
const ExpirySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("forever") }),
  z.object({ mode: z.literal("ttl"), ttl: z.number().int().positive() }),
])

const CreateSnipSchema = z.object({
  key: z.string(),
  type: z.enum(["text", "image", "file"]),
  content: z.string().min(1, { error: "content 不得为空" }),
  source: z.string().min(1, { error: "source 不得为空" }),
  expiry: ExpirySchema,
})

// 路由处理器中
const result = CreateSnipSchema.safeParse(await c.req.json())
if (!result.success) {
  return c.json({
    error: { code: "INVALID_INPUT", message: result.error.issues, requestId: c.get("requestId") }
  }, 400)
}
```

**响应体（201）：**

```json
{
  "key": "my-note",
  "type": "text",
  "source": "page",
  "size": 11,
  "createdAt": "2026-07-09T00:00:00.000Z",
  "expiresAt": "2026-07-10T00:00:00.000Z"
}
```

`key` 字段始终在响应中返回，无论是用户提供的还是服务端生成的，接收方凭此 key 查询。

### 5.2 GET /snip/:key — 读取 snip

响应体同时包含元数据和负载内容：

```json
{
  "key": "my-note",
  "type": "text",
  "source": "page",
  "size": 11,
  "createdAt": "2026-07-09T00:00:00.000Z",
  "expiresAt": "2026-07-10T00:00:00.000Z",
  "content": "hello world"
}
```

### 5.3 GET /snip — 列出所有 snip

返回元数据列表，不包含 `content` 字段，支持分页：

```json
{
  "items": [
    {
      "key": "my-note",
      "type": "text",
      "size": 11,
      "createdAt": "2026-07-09T00:00:00.000Z",
      "expiresAt": "2026-07-10T00:00:00.000Z"
    }
  ],
  "cursor": "next-page-cursor"
}
```

## 7. 存储模型

元数据与负载分开存储，分别使用 Cloudflare KV 和 R2，以保持列表查询的高效性，同时支持后续添加大文件或二进制负载。

### 7.1 KV 存储（元数据）

每个 snip 在 KV 中对应一条记录，KV key 为 `snip:{key}`，value 为 JSON 字符串：

**KV 写入：**
```ts
await env.SNIPFLOW_KV.put(
  `snip:${key}`,
  JSON.stringify(metadata),
  { expirationTtl: ttlSeconds }   // 可选，永久保存时不传
)
```

**KV 读取：**
```ts
const raw = await env.SNIPFLOW_KV.get(`snip:${key}`)
```

**KV 列表（分页）：**
```ts
const list = await env.SNIPFLOW_KV.list({ prefix: 'snip:', limit: 100, cursor })
```

**KV 删除：**
```ts
await env.SNIPFLOW_KV.delete(`snip:${key}`)
```

**KV 计数器（维护 stats）：**
```
// 创建时递增
await env.SNIPFLOW_KV.put('meta:count', String(count + 1))
await env.SNIPFLOW_KV.put('meta:totalSize', String(totalSize + size))

// 删除时递减
await env.SNIPFLOW_KV.put('meta:count', String(count - 1))
await env.SNIPFLOW_KV.put('meta:totalSize', String(totalSize - size))
```

**KV 中存储的元数据结构：**

```json
{
  "key": "my-note",
  "type": "text",
  "source": "page",
  "size": 11,
  "createdAt": "2026-07-09T00:00:00.000Z",
  "expiresAt": "2026-07-10T00:00:00.000Z",
  "r2Key": "snips/my-note/payload"
}
```

`r2Key` 字段记录对应的 R2 对象路径，用于读取和删除负载时定位。

### 7.2 R2 存储（负载内容）

每个 snip 的实际内容存储为一个 R2 对象，key 为 `snips/{key}/payload`。

**R2 写入：**
```ts
await env.SNIPFLOW_R2.put(
  `snips/${key}/payload`,
  content,
  { httpMetadata: { contentType: mime } }
)
```

**R2 读取：**
```ts
const obj = await env.SNIPFLOW_R2.get(`snips/${key}/payload`)
const content = await obj.text()   // 或 .arrayBuffer() / .stream()
```

**R2 删除：**
```ts
await env.SNIPFLOW_R2.delete(`snips/${key}/payload`)
```

### 7.3 创建 / 删除的原子性保证

KV 和 R2 不支持事务，通过以下顺序降低不一致风险：

- **创建**：先写 R2，再写 KV。若 KV 写入失败，孤立的 R2 对象可通过定期清理任务回收。
- **删除**：先删 KV，再删 R2。若 R2 删除失败，KV 已不存在该记录，R2 对象变为不可达孤立对象，同样由清理任务处理。

## 8. 内部分层

关于环境变量类型：所有环境变量（`SNIPFLOW_API_TOKEN`、`SNIPFLOW_TOTAL_STORAGE_LIMIT`、`SNIPFLOW_MAX_SNIP_SIZE`、`SNIPFLOW_DISGUISE`）和 binding（KV、R2）均在 `wrangler.jsonc` 的 `vars` / `kv_namespaces` / `r2_buckets` 中声明，随服务一起部署。运行 `wrangler types` 会自动生成 `worker-configuration.d.ts`，其中包含完整的 `Env` 类型，代码中直接引用该类型，不需要额外的 `env.ts`。

**目录结构：**

```
src/
  index.ts                  Worker 入口：注册 fetch handler 和 scheduled handler
  app.ts                    构建 Hono app，挂载中间件和路由

  routes/
    health.ts               GET /health 和 GET /health/auth
    snip.ts                 POST/GET /snip 和 GET/DELETE /snip/:key
    stats.ts                GET /stats

  middleware/
    request-id.ts           挂载 hono/request-id（Request ID 注入）
    guard.ts                方法白名单过滤（GET/POST/DELETE）、请求体大小限制 100 MB（hono/body-limit）
    auth.ts                 Bearer Token 校验（hono/bearer-auth），通过回调抛出 UnauthorizedError
    content-type.ts         POST 写请求的 Content-Type 校验

  schemas/
    snip.ts                 CreateSnipSchema、SnipMetaSchema（Zod）
    stats.ts                StatsSchema

  services/
    snip/
      create.ts             创建 snip 业务逻辑
      list.ts               列出 snip 业务逻辑
      read.ts               读取单个 snip 业务逻辑
      delete.ts             删除 snip 业务逻辑
    stats.ts                存储统计业务逻辑

  repositories/
    kv.ts                   KV 读写封装（put / get / list / delete / counter）
    r2.ts                   R2 读写封装（put / get / delete / list）

  domain/
    types.ts                SnipMeta、CreateSnipInput 等核心类型
    errors.ts               AppError 基类及各子类（NotFoundError、UnauthorizedError 等）

  utils/
    key.ts                  snip key 随机生成（nanoid）
    time.ts                 时间工具（ISO 格式化、TTL 转时间戳）

  jobs/
    cleanup.ts              Cron Trigger 清理任务：扫描 R2 孤立对象
```

**为什么 services 按操作拆分文件：** snip 的增删查彼此独立，依赖的仓储方法不同，拆分后每个文件职责单一、测试隔离，不会出现一个需要通读全文才能定位逻辑的大文件。

**各层职责：**

| 层级 | 职责 |
|------|------|
| routes | 解析路径参数和请求体，调用服务层，返回 HTTP 响应 |
| middleware | 处理跨请求的横切行为（Request ID、守卫、认证、Content-Type） |
| schemas | 用 Zod 定义并校验请求输入和响应输出的边界类型 |
| services | 承载业务逻辑，协调 KV 与 R2 的读写顺序，处理计数器更新 |
| repositories | 封装对 KV 和 R2 的原始 API 调用，返回类型化结果 |
| domain | 定义跨层共享的稳定类型和错误基类 |
| utils | 仅包含无副作用的小型工具函数 |
| jobs | Cron Trigger 定时任务（R2 孤立对象清理） |

## 9. 解耦原则

- 路由处理器不直接调用 KV 或 R2，只通过服务层操作
- 服务层不依赖 Hono context，只接收纯参数，便于单元测试
- 仓储层不感知请求来源，只负责 KV / R2 的读写
- `source` 是元数据，不作为权限边界
- 新增内容类型在 schemas / services 层扩展，不引入新的顶层存储概念
- 新客户端复用 `/snip`，不引入客户端专属路由

## 10. 测试策略

使用 Vitest + `@cloudflare/vitest-pool-workers`，在真实 Workers 运行时中执行测试，不使用 mock，确保 KV / R2 行为与生产一致。

**测试分层：**

| 层级 | 测试类型 | 覆盖目标 |
|------|---------|---------|
| repositories | 单元测试 | KV key 格式、R2 对象路径、计数器读写、空值处理 |
| schemas | 单元测试 | 合法/非法输入的 safeParse 结果，每个字段的边界值 |
| services | 单元测试 | 业务分支（TTL/forever、key 为空时生成 ID、delete 后计数递减） |
| routes | 集成测试 | 完整 HTTP 请求/响应周期，包含中间件链 |
| jobs | 集成测试 | cleanup 扫描逻辑：有 KV 对应的 R2 对象不删，无 KV 的删除 |

**关键测试用例（按层）：**

_repositories/kv_
- `putSnip` 写入后 `getSnip` 能取到相同内容
- `putSnip` 带 `expirationTtl` 写入后 key 存在于 KV
- `deleteSnip` 后 `getSnip` 返回 null
- `listSnips` 返回 `snip:` 前缀的所有 key

_repositories/r2_
- `putPayload` 写入后 `getPayload` 返回相同内容
- `deletePayload` 后 `getPayload` 返回 null
- `listPayloads` 返回 `snips/` 前缀的所有对象

_schemas/snip_
- `CreateSnipSchema.safeParse` 对合法输入返回 `success: true`
- `type` 传入 `"link"` 返回失败，错误指向 `type` 字段
- `content` 为空字符串返回失败
- `expiry.mode = "ttl"` 且缺少 `ttl` 字段返回失败
- `expiry.mode = "forever"` 且附带 `ttl` 字段应被忽略或返回失败

_services/snip/create_
- `key` 为 `""` 时响应中 key 为随机生成的非空字符串
- `key` 为 `"abc"` 时响应中 key 为 `"abc"`
- 创建后 stats `count` 递增 1，`totalSize` 递增对应字节数
- `mode = "ttl"` 创建后 KV 条目携带过期时间

_services/snip/delete_
- delete 后 `getSnip` 返回 404
- delete 后 stats `count` 递减 1

_routes（集成）_
- `GET /health` 无 Token 返回 200
- `GET /health/auth` 无 Token 返回 401
- `GET /health/auth` 携带正确 Token 返回 200
- `POST /snip` 缺少 `content` 字段返回 400，body 包含 `INVALID_INPUT`
- `POST /snip` → `GET /snip/:key` → `DELETE /snip/:key` 完整生命周期
- 伪装模式开启时，401 场景改为返回 200 `<h1>Hello World</h1>`

_jobs/cleanup_
- R2 有对象、KV 有对应 metadata：不删除
- R2 有对象、KV 无对应 metadata：删除

## 11. Roadmap

从最外层开始，由外至内逐层推进，每个阶段完成后均可独立运行并以测试验证。

---

### 阶段一：项目骨架与最小可跑通状态

**目标：** Worker 可以启动并响应 `/health`，所有基础配置就位。

实现步骤：
1. 配置 `wrangler.jsonc`：dev port 10001、ip 0.0.0.0，添加 `vars` 占位符（`SNIPFLOW_API_TOKEN`、`SNIPFLOW_TOTAL_STORAGE_LIMIT`、`SNIPFLOW_MAX_SNIP_SIZE`、`SNIPFLOW_DISGUISE`）
2. 运行 `wrangler types` 生成 `worker-configuration.d.ts`
3. 编写 `src/index.ts`：导出 `default { fetch }` 交给 Hono app
4. 编写 `src/app.ts`：创建 Hono app，挂载 `GET /health` 返回 `{ ok: true }`

验收测试：
```
GET /health → 200 { ok: true }
PUT /health → 405（任意不支持方法）
```

---

### 阶段二：中间件层

**目标：** 所有请求在到达路由前经过完整的守卫链，错误响应格式统一。

实现步骤：
5. 编写 `src/domain/errors.ts`：`AppError` 及子类，`handleError` 全局错误处理函数（含伪装模式逻辑）
6. 编写 `src/middleware/request-id.ts`：挂载 `hono/request-id`
7. 编写 `src/middleware/guard.ts`：方法白名单 + `hono/body-limit`（100 MB 硬编码）
8. 编写 `src/middleware/content-type.ts`：POST 请求校验 `application/json`
9. 编写 `src/middleware/auth.ts`：`hono/bearer-auth`，通过 `invalidToken` / `noAuthenticationHeader` 回调抛出 `UnauthorizedError`
10. 添加 `GET /health/auth` 路由（复用 auth 中间件，返回 `{ ok: true, authed: true }`）
11. 在 `app.ts` 中注册 `app.onError(handleError)` 并按序挂载所有中间件

验收测试：
```
GET  /health           无 Token → 200 { ok: true }
GET  /health/auth      无 Token → 401 UNAUTHORIZED（或伪装模式 200 Hello World）
GET  /health/auth      正确 Token → 200 { ok: true, authed: true }
POST /snip             Content-Type: text/plain → 415
POST /snip（正确头）    body > 100MB → 413
所有响应               包含 X-Request-Id 响应头
```

---

### 阶段三：领域类型与基础设施层

**目标：** 建立类型基础，封装底层存储访问，不包含任何业务逻辑。

实现步骤：
12. 编写 `src/domain/types.ts`：`SnipMeta`、`CreateSnipInput`、`SnipExpiry`
13. 编写 `src/utils/key.ts`：`generateKey()` 基于 nanoid，生成随机 snip 标识符
14. 编写 `src/utils/time.ts`：`ttlToExpiresAt(ttl)`、ISO 格式化
15. 编写 `src/repositories/kv.ts`：`getSnip`、`putSnip`、`deleteSnip`、`listSnips`、`getCounter`、`setCounter`
16. 编写 `src/repositories/r2.ts`：`putPayload`、`getPayload`、`deletePayload`、`listPayloads`

验收测试（单元）：
```
kv.putSnip → kv.getSnip 返回相同内容
kv.deleteSnip → kv.getSnip 返回 null
r2.putPayload → r2.getPayload 返回相同内容
r2.deletePayload → r2.getPayload 返回 null
kv.listSnips 只返回 snip: 前缀的 key
r2.listPayloads 只返回 snips/ 前缀的对象
```

---

### 阶段四：Schema 校验层

**目标：** 请求体在进入业务逻辑前完成结构校验，非法输入有明确错误字段指向。

实现步骤：
17. 编写 `src/schemas/snip.ts`：`ExpirySchema`（discriminatedUnion）、`CreateSnipSchema`（包含 `content` 字段大小校验，上限由环境变量 `SNIPFLOW_MAX_SNIP_SIZE` 决定）、`SnipMetaSchema`
18. 编写 `src/schemas/stats.ts`：`StatsSchema`

验收测试（单元）：
```
合法请求体 → safeParse success: true
type = "link" → success: false，issues 指向 type 字段
content = "" → success: false，issues 指向 content 字段
content 超过 SNIPFLOW_MAX_SNIP_SIZE → success: false，issues 指向 content 字段
expiry.mode = "ttl" 且无 ttl → success: false，issues 指向 expiry.ttl
expiry.mode = "forever" → success: true
```

---

### 阶段五：服务层

**目标：** 将业务规则编码为纯函数，不依赖 Hono context，覆盖所有业务分支。

实现步骤：
19. 编写 `src/services/snip/create.ts`：key 为空时生成随机 key 并检查冲突（最多重试 3 次），用户提供的 key 需检查是否已存在（`overwrite=false` 时冲突返回 `KeyConflictError`），先写 R2 再写 KV，按 expiry 设 TTL，更新计数器，R2 写入失败时回滚
20. 编写 `src/services/snip/read.ts`：读 KV metadata + 读 R2 payload，任一不存在返回 NotFoundError
21. 编写 `src/services/snip/list.ts`：KV list 分页，返回元数据列表
22. 编写 `src/services/snip/delete.ts`：先删 KV 再删 R2，更新计数器
23. 编写 `src/services/stats.ts`：读 KV 计数器，拼入 `SNIPFLOW_TOTAL_STORAGE_LIMIT`

验收测试（单元）：
```
create key="" → 返回 meta.key 为非空随机字符串
create key="abc" → 返回 meta.key = "abc"
create key="abc"（已存在，overwrite=false）→ 抛出 KeyConflictError
create key="abc"（已存在，overwrite=true）→ 成功覆盖
create mode="ttl" → KV 条目携带 expiresAt
create → stats count+1，totalSize += size
delete → stats count-1，totalSize -= size
read 不存在的 key → 抛出 NotFoundError
delete 不存在的 key → 抛出 NotFoundError
```

---

### 阶段六：路由层

**目标：** 将服务层能力暴露为 HTTP 接口，端到端完整可用。

实现步骤：
24. 编写 `src/routes/snip.ts`：接入 `CreateSnipSchema.safeParse`，调用 `services/snip/*`
25. 编写 `src/routes/stats.ts`：调用 `services/stats`
26. 在 `app.ts` 中注册全部路由

验收测试（集成）：
```
POST /snip（合法）→ 201，body 包含 key、type、size、createdAt
POST /snip 缺字段 → 400 INVALID_INPUT，body 含 issues 列表
POST /snip（key 已存在，overwrite=false）→ 409 KEY_CONFLICT
POST /snip（key 已存在，overwrite=true）→ 201，成功覆盖
GET  /snip/:key（存在）→ 200，body 包含 content
GET  /snip/:key（不存在）→ 404 NOT_FOUND
DELETE /snip/:key → 204
GET  /snip → 200，body 包含 items 数组和 cursor
GET  /stats → 200，body 包含 count / totalSize / storageLimit
完整生命周期：create → read → list（count=1）→ delete → list（count=0）
```

---

### 阶段七：定时清理任务

**目标：** 自动清理 KV 已过期但 R2 对象仍存在的孤立数据。

实现步骤：
27. 编写 `src/jobs/cleanup.ts`：list R2 所有对象，查 KV，无元数据则删除 R2 对象
28. 在 `src/index.ts` 中导出 `scheduled` handler
29. 在 `wrangler.jsonc` 中配置 `"triggers": { "crons": ["0 * * * *"] }`

验收测试（集成）：
```
R2 有对象、KV 有 metadata → cleanup 后 R2 对象仍存在
R2 有对象、KV 无 metadata → cleanup 后 R2 对象被删除
```
本地用 `wrangler dev --test-scheduled` + `curl /__scheduled` 触发验证。

---

### 阶段八：部署与线上验收

**目标：** 在真实 Cloudflare 环境中验证全链路正常运行。

实现步骤：
30. 在 Cloudflare Dashboard 创建 KV namespace 和 R2 bucket，填入 `wrangler.jsonc`
31. 配置生产 secrets（`wrangler secret put SNIPFLOW_API_TOKEN` 等）
32. `pnpm deploy`

验收清单：
```
GET  /health → 200
GET  /health/auth（正确 Token）→ 200
GET  /health/auth（错误 Token，伪装模式开启）→ 200 Hello World
POST /snip（TTL 模式）→ 201，等待过期后 GET 返回 404
POST /snip（forever 模式）→ 201，DELETE 后 GET 返回 404
GET  /stats → count 和 totalSize 与实际操作一致，storageLimit 与 SNIPFLOW_TOTAL_STORAGE_LIMIT 一致
Cron 触发后孤立 R2 对象被清理（通过 R2 Dashboard 确认）
```
