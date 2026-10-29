# 接口索引与核心契约

更新：2026-10-20。本文按 V4.2 整理；0.7.7.1 新增的付费与客服接口尚未收录，以 `server/src/modules/commercial/routes.ts` 和 `server/src/modules/support/routes.ts` 为准。先阅读通用约定，再按业务定位路由；请求字段和范围由路由中的校验定义，返回结构由对应服务定义。新增或修改接口时同步更新本文与回归测试。

## 通用约定

- 业务前缀为`/v1`。普通成功响应是`{"data": ...}`；失败响应是`{"code": "...", "message": "...", "requestId": "..."}`。
- 用户接口携带`Authorization: Bearer <session-token>`，只读写当前用户自己的数据；他人资源不暴露存在性。管理员接口使用独立会话，不使用学习用户令牌。
- 登录、公开配置、健康检查、公开学习内容、图片素材及法律文档按各自路由允许匿名访问；公开路径不能据此取得个人进度或私密图片。
- 导出返回JSON文件本体，图片返回二进制；流式对话返回SSE。客户端先看响应类型，不能对所有成功响应统一读取`data`。
- JSON请求体上限256 KiB；图片接口通常为5 MB，文件导入和聊天文件附件为10 MB。multipart字段为`file`；具体类型、张数和长度由路由校验。
- 时间戳通常为ISO 8601；业务日期、复习与预算按北京时间。版本字段、幂等标识必须沿用发起操作时的值，不得在自动重试时随意生成新值。

| 状态 | 常见错误 | 客户端处理 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`、`INVALID_JSON` | 显示输入问题，修正后重试 |
| 401 | `AUTH_REQUIRED`、`SESSION_EXPIRED` | 只对当前会话处理登录过期，不能清除后来新建的会话 |
| 403 | `ACCOUNT_BANNED`、管理来源校验错误 | 显示不可用原因，账号仍可使用允许的导出和注销入口 |
| 404 | `NOT_FOUND` | 内容不存在、已删或无访问权限 |
| 409 | 版本冲突、状态变化或已有操作运行 | 重新读取当前内容，保留用户未提交输入 |
| 413、415 | 文件过大或类型不支持 | 选择符合要求的文件 |
| 429 | `DAILY_LIMIT`、请求限流 | 显示服务端给出的预算或频率提示，不盲目重试 |
| 502、503 | 外部服务不可用、生成结果未通过校验 | 保留输入，按明确失败或结果未知分别处理 |

## 可直接运行的请求示例

以下示例使用本地入口`http://localhost:8788`，仅查询公开配置或触发未登录错误，不创建用户数据。先按[运行说明](../README.md#第一次本地运行)启动后端。

读取公开配置，无须携带用户令牌：

```bash
curl -i http://localhost:8788/v1/config
```

新建开发数据库、开启开发登录且尚未配置外部服务时，成功响应为HTTP `200`：

```json
{
  "data": {
    "appName": "晓念",
    "devLogin": true,
    "ai": false,
    "judge": false,
    "ocr": false,
    "limits": {
      "textChars": 2000,
      "imageBytes": 5242880
    }
  }
}
```

`devLogin/ai/judge/ocr`根据当前配置变化；配置为可用不表示外部服务已经联通。字段来源见[基础路由](../server/src/index.ts)，长度限制见[资料服务](../server/src/modules/materials/service.ts)。

不带`Authorization`请求当前用户：

```bash
curl -i http://localhost:8788/v1/auth/me
```

响应为HTTP `401`，JSON结构如下；`requestId`由服务端生成，示例值仅用于展示：

```json
{
  "code": "AUTH_REQUIRED",
  "message": "登录过期了，重新打开晓念就好",
  "requestId": "example-request-id"
}
```

该错误在[会话鉴权](../server/src/modules/auth/service.ts)中产生，统一由[请求错误处理入口](../server/src/index.ts)包装；客户端应按状态码和`code`处理，不能依赖中文提示文本匹配。

## 核心调用流程

### 登录和同意

开发登录为`POST /v1/auth/dev-login`，请求`{key?, nickname?}`，仅开发登录开启时可用。真实登录为`POST /v1/auth/wechat-login`，请求`{code}`，code由微信登录取得。成功返回`{token, user, expiresAt}`；OpenID不下发给客户端。

`PUT /v1/me/consent`接收`{version, ageBand, guardian?}`；`ageBand`为`adult`或`child`，并非精确年龄。隐私版本须与服务端当前版本一致。心情同意为独立接口，不能用一般同意状态替代。

### 卡片

`POST /v1/cards`可携带`text/quote`、`kind/type`、`scene`、`title`、`mine`、`clientId`及来源关联字段。正文／原话单项最多2000字，标题16字，自己的理解300字；这些字段是输入上限，仍需通过服务端业务检查。列表支持种类、场景、标签、收藏、关键词和游标筛选。

编辑卡片、补充、合并和整理分别有独立接口。带版本的操作要使用最近读取的版本；先保存用户输入，再根据任务状态更新生成结果。完整字段见 [卡片路由](../server/src/modules/cards/routes.ts)与[卡片结构](../server/src/modules/cards/schema.ts)。

### 对话、附件与SSE

`POST /v1/chat/send`必填`clientId`（8—64位字母、数字、下划线或短横线），可带`threadId`、`text`、`problem`、`imageId`、`attachmentIds`、`steps`、`mode`、`sceneChoice`、`cardIds`、`quote`和`tone`等。`mode`为`auto/solution/grade`；文字最多2000字，附件最多4个，主动带入卡片最多3张。精确字段见 [对话路由](../server/src/modules/chat/routes.ts)。

SSE每帧为`data: <JSON>\n\n`，最后为`data: [DONE]`。中文按Unicode转义传输，客户端按字节拼接并处理完整帧。常用事件包含开始、已排版块、正在生成的尾段、完成与错误；风险分支可发送`crisis`终态。服务端完整事件类型见 [ChatEvent](../server/src/modules/chat/service.ts)，客户端处理见`miniprogram/utils/`。

首帧前失败返回普通JSON错误；首帧后失败通过事件返回。断线后服务端可能继续处理并保存，应读取对话历史确认结果。不得仅因连接中断就再次创建一条新请求。旧请求完成时不能覆盖新草稿，图片删除还需确认没有其他内容引用。

### 导入和头脑风暴

文字导入`POST /v1/imports`接受`{text, clientId?, own?}`，输入最多60000字；一轮保留和处理范围由服务端分段逻辑控制，剩余内容通过后续导入入口继续。文件上传为multipart `file`，查询参数支持`clientId/start/own`；照片接口另需`source/index/count`。先读取并校对原文，再拆卡和选择保存，不能绕过确认直接把全部识别内容作为用户认可的资料。

头脑风暴`POST /v1/brainstorms`接受`{clientId, cardIds}`，选择3—50张当前用户卡片。创建、更新选择、生成报告、保存卡片分开执行；原文变更后报告可能过期。导入与头脑风暴列表支持读取未完成记录，返回后可继续原流程。

### 任务与预算

`GET /v1/jobs/:id`读取自己的后台任务。队列、运行、成功、失败与结果未知应分别展示；创建请求返回任务不等于工作已完成。失败是否允许重试由服务端判断，管理员重试不应变成重复计费或新建重复内容。

用户当前预算通过`GET /v1/me/usage`读取；日／周预算依据配置价格表与成功消耗记录，另有每日安全次数上限。旧类别计数字段保留兼容用途，不能代替当前预算结果。个人预算和匿名调用总账用途不同，均不能直接代表服务方实付账单。

### 可选头像和昵称

登录仍通过 `wx.login` 和服务端 `code2Session` 识别同一账号；头像、昵称仅用于展示，修改不会新建账号或改变资料归属。客户端使用微信原生 `chooseAvatar` 和 `input type="nickname"`，由用户主动选择、填写，不能静默取得微信资料，也不能依赖已回收的旧资料接口。

`GET /v1/auth/me` 返回当前账号最新公开资料，`avatar` 为 `{version}` 或 `null`。头像的服务器路径不会返回；前端须带现有 Bearer 会话调用头像下载接口，再使用返回的临时文件显示，不能把令牌放进 URL。

| 操作 | 请求 | 结果 |
| --- | --- | --- |
| 修改昵称 | `PATCH /v1/me/profile`，JSON `{"nickname":"小林"}` | 返回更新后的公开用户资料 |
| 保存头像及可选昵称 | `POST /v1/me/profile`，multipart 字段 `file`、可选 `nickname` | 整体保存；失败时保留原资料 |
| 读取本人头像 | `GET /v1/me/profile/avatar?v=<version>`，带鉴权头 | 返回当前版本图片；无头像或版本已过期时返回未找到 |
| 恢复默认 | `DELETE /v1/me/profile`，JSON `{"avatar":true,"nickname":true}` | 可单独清除头像或重置昵称；不删除学习资料 |

头像仅接收 JPEG／PNG，单张最多 2 MiB、边长不超过 4096 像素；这些是项目限制。服务端检查图片容器结构和尺寸，不宣称完整像素解码验证。昵称去除首尾空白后为 1—24 个 UTF-16 代码单元（多数汉字占 1 个，部分表情占 2 个），不接受控制字符。接口不接受账号编号、OpenID、外部头像 URL 或文件路径作为可修改字段。原生昵称检查未通过或超时不能当作保存成功。

新增或修改资料需要当前隐私版本（2026-10-25 起为 `2026-10-25.1`）的同意，儿童账号同时需要该版本监护人同意。旧版本 `2026-10-24.1`、`2026-10-20.2`、`2026-10-20.1` 和 `2026-10-17.1` 仍可用于原有功能，同意记录保留用户实际阅读的版本。清除资料、导出和注销保留原有账号权利入口。用户导出的 JSON 包含昵称和头像描述，不包含头像图片二进制。头像不创建学习材料、不调用 AI、不消耗识图额度；完整备份必须包含头像文件。

## 按模块查路由

以下列出当前静态注册的业务路由及学习接口中的循环注册项。查询参数、请求结构、鉴权与返回字段点击每组的源码入口查看；不将路由清单当作可跳过参数校验的调用样例。

### 基础、会话与健康

**基础入口**：[请求校验与处理入口](../server/src/index.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/health/live` |
| `GET` | `/health/ready` |
| `GET` | `/metrics` |
| `GET` | `/v1/config` |
| `POST` | `/v1/auth/dev-login` |
| `POST` | `/v1/auth/wechat-login` |
| `GET` | `/v1/auth/me` |
| `POST` | `/v1/auth/logout` |
| `GET` | `/v1/jobs/:id` |
| `GET` | `/v1/admin/overview` |
| `GET` | `/v1/admin/audit` |
| `GET` | `/v1/admin/operations` |

**管理员会话**：[请求校验与处理入口](../server/src/modules/auth/admin-session.ts)。

| 方法 | 路径 |
| --- | --- |
| `POST` | `/v1/admin/session` |
| `GET` | `/v1/admin/session` |
| `DELETE` | `/v1/admin/session` |

### 账号、同意与心情

**账号**：[请求校验与处理入口](../server/src/modules/account/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/me/usage` |
| `GET` | `/v1/me/export` |
| `PUT` | `/v1/me/consent` |
| `GET` | `/v1/me/consent` |
| `DELETE` | `/v1/me/consent` |
| `GET` | `/v1/me/prefs` |
| `PUT` | `/v1/me/prefs` |
| `PATCH` | `/v1/me/profile` |
| `POST` | `/v1/me/profile` |
| `DELETE` | `/v1/me/profile` |
| `GET` | `/v1/me/profile/avatar` |
| `DELETE` | `/v1/me` |

**心情**：[请求校验与处理入口](../server/src/modules/safety/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/mood` |
| `PUT` | `/v1/me/mood-consent` |
| `DELETE` | `/v1/me/mood-consent` |
| `DELETE` | `/v1/mood` |

**学习时长**：[请求校验与处理入口](../server/src/modules/study-time/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `POST` | `/v1/me/study-time` |
| `GET` | `/v1/me/study-time` |
| `DELETE` | `/v1/me/study-time` |

### 卡片与接续

**卡片**：[请求校验与处理入口](../server/src/modules/cards/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/cards/stats` |
| `GET` | `/v1/cards/learning/:proofId` |
| `POST` | `/v1/cards/:id/learning-close` |
| `GET` | `/v1/cards` |
| `POST` | `/v1/cards` |
| `POST` | `/v1/cards/merge` |
| `POST` | `/v1/cards/:id/unmerge` |
| `GET` | `/v1/cards/:id` |
| `POST` | `/v1/cards/:id/tidy` |
| `POST` | `/v1/cards/:id/answer` |
| `PATCH` | `/v1/cards/:id` |
| `PUT` | `/v1/cards/:id/favorite` |
| `DELETE` | `/v1/cards/:id` |
| `PUT` | `/v1/cards/:id/tags` |
| `POST` | `/v1/cards/:id/mine` |
| `POST` | `/v1/cards/:id/supplements` |
| `POST` | `/v1/cards/:id/close` |
| `POST` | `/v1/cards/:id/links` |
| `DELETE` | `/v1/cards/:id/links/:otherId` |
| `GET` | `/v1/tags` |
| `POST` | `/v1/tags` |
| `PATCH` | `/v1/tags/:id` |
| `DELETE` | `/v1/tags/:id` |

**接续**：[请求校验与处理入口](../server/src/modules/resume/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/resume/settings` |
| `PUT` | `/v1/resume/settings` |
| `GET` | `/v1/resume` |
| `POST` | `/v1/resume/open` |
| `POST` | `/v1/resume/undo` |
| `POST` | `/v1/resume/:id/act` |
| `POST` | `/v1/resume/:id/ai` |
| `POST` | `/v1/resume/:id/feedback` |
| `POST` | `/v1/resume/:id/when` |

**旧笔记兼容**：[请求校验与处理入口](../server/src/modules/notes/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `POST` | `/v1/notes` |
| `GET` | `/v1/notes` |
| `GET` | `/v1/notes/:id` |
| `PUT` | `/v1/notes/:id` |
| `DELETE` | `/v1/notes/:id` |
| `POST` | `/v1/notes/:id/organize` |
| `POST` | `/v1/notes/:id/supplements` |
| `PUT` | `/v1/notes/:id/items/:itemId` |
| `DELETE` | `/v1/notes/:id/items/:itemId` |
| `PUT` | `/v1/notes/:id/point` |

### 对话与学习工具

**对话**：[请求校验与处理入口](../server/src/modules/chat/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `POST` | `/v1/chat/send` |
| `GET` | `/v1/chat/threads` |
| `POST` | `/v1/chat/threads` |
| `PATCH` | `/v1/chat/threads/:id` |
| `PUT` | `/v1/chat/threads/:id/cards` |
| `POST` | `/v1/chat/threads/:id/suggest-cards` |
| `POST` | `/v1/chat/threads/:id/wrap` |
| `GET` | `/v1/me/suggest-cards` |
| `PUT` | `/v1/me/suggest-cards` |
| `GET` | `/v1/chat/threads/:id` |
| `DELETE` | `/v1/chat/threads/:id` |
| `GET` | `/v1/chat/messages/:id` |
| `GET` | `/v1/chat/usage` |
| `POST` | `/v1/chat/scan` |
| `POST` | `/v1/chat/attachments` |
| `DELETE` | `/v1/chat/attachments/:id` |
| `POST` | `/v1/chat/homework` |
| `POST` | `/v1/chat/threads/:id/homework/:index` |
| `POST` | `/v1/chat/threads/:id/homework/:index/mistake` |
| `POST` | `/v1/chat/drafts` |
| `POST` | `/v1/chat/threads/:id/teach-review` |
| `GET` | `/v1/chat/images/:id` |
| `POST` | `/v1/chat/threads/:id/answer` |
| `POST` | `/v1/chat/threads/:id/similar` |
| `POST` | `/v1/chat/practice` |
| `POST` | `/v1/chat/messages/:id/answer` |
| `POST` | `/v1/chat/messages/:id/mistake` |
| `POST` | `/v1/chat/messages/:id/reveal` |

**错题**：[请求校验与处理入口](../server/src/modules/mistakes/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/mistakes` |
| `POST` | `/v1/mistakes/:id` |
| `DELETE` | `/v1/mistakes/:id` |

**学习概况**：[请求校验与处理入口](../server/src/modules/home/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/home` |

### 导入与头脑风暴

**导入**：[请求校验与处理入口](../server/src/modules/imports/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `POST` | `/v1/imports` |
| `POST` | `/v1/imports/file` |
| `POST` | `/v1/imports/photo` |
| `GET` | `/v1/imports` |
| `GET` | `/v1/imports/:id` |
| `PATCH` | `/v1/imports/:id` |
| `POST` | `/v1/imports/:id/read` |
| `POST` | `/v1/imports/:id/cards` |
| `POST` | `/v1/imports/:id/save` |
| `POST` | `/v1/imports/:id/rest` |
| `POST` | `/v1/imports/:id/page` |
| `POST` | `/v1/imports/:id/abandon` |
| `DELETE` | `/v1/imports/:id` |

**头脑风暴**：[请求校验与处理入口](../server/src/modules/brainstorm/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `POST` | `/v1/brainstorms` |
| `GET` | `/v1/brainstorms/suggest` |
| `POST` | `/v1/brainstorms/suggest/dismiss` |
| `GET` | `/v1/brainstorms` |
| `GET` | `/v1/brainstorms/:id` |
| `PUT` | `/v1/brainstorms/:id/picks` |
| `POST` | `/v1/brainstorms/:id/save` |
| `POST` | `/v1/brainstorms/:id/report` |
| `DELETE` | `/v1/brainstorms/:id` |

### 资料、学习与复习

**资料**：[请求校验与处理入口](../server/src/modules/materials/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `POST` | `/v1/materials` |
| `POST` | `/v1/materials/image` |
| `GET` | `/v1/materials` |
| `GET` | `/v1/materials/:id` |
| `GET` | `/v1/materials/:id/image` |
| `GET` | `/v1/materials/:id/versions` |
| `GET` | `/v1/materials/:id/versions/:version` |
| `PUT` | `/v1/materials/:id` |
| `POST` | `/v1/materials/:id/ocr` |
| `DELETE` | `/v1/materials/:id` |

**资料学习**：[请求校验与处理入口](../server/src/modules/study/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/materials/:id/study` |
| `POST` | `/v1/materials/:id/ask` |
| `POST` | `/v1/materials/:id/variant` |
| `POST` | `/v1/materials/:id/attempts` |
| `GET` | `/v1/attempts/:id` |
| `POST` | `/v1/artifacts/:id/reveal` |
| `POST` | `/v1/artifacts/:id/report` |
| `POST` | `/v1/materials/:id/explain` |
| `POST` | `/v1/materials/:id/quiz` |
| `POST` | `/v1/materials/:id/hints` |

**复习**：[请求校验与处理入口](../server/src/modules/review/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `POST` | `/v1/materials/:id/review` |
| `DELETE` | `/v1/materials/:id/review` |
| `GET` | `/v1/reviews` |
| `POST` | `/v1/reviews/:id` |

**学习地图**：[请求校验与处理入口](../server/src/modules/learn/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/learn/bank` |
| `GET` | `/v1/learn/bank/public` |
| `GET` | `/v1/learn/points/:id/detail` |
| `POST` | `/v1/learn/points/:id/example-shown` |
| `GET` | `/v1/learn/points/:id/detail/public` |
| `GET` | `/v1/learn/points/:id/practice` |
| `POST` | `/v1/learn/points/:id/submit` |
| `GET` | `/v1/learn/map` |
| `GET` | `/v1/learn/map/public` |
| `GET` | `/v1/learn/map/graph` |
| `GET` | `/v1/me/settings` |
| `PUT` | `/v1/me/settings` |
| `POST` | `/v1/learn/map/events` |
| `POST` | `/v1/learn/points/:id/stuck` |
| `GET` | `/v1/learn/points/:id/stuck` |
| `GET` | `/v1/learn/points/:id` |
| `GET` | `/v1/learn/points/:id/hint` |
| `POST` | `/v1/learn/points/:id/answer` |
| `POST` | `/v1/learn/marks` |
| `POST` | `/v1/learn/points/:id/report` |

### 管理与公开资源

**管理统计**：[请求校验与处理入口](../server/src/modules/admin/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/admin/jobs` |
| `GET` | `/v1/admin/quality` |
| `GET` | `/v1/admin/usage` |

**管理操作**：[请求校验与处理入口](../server/src/modules/admin/manage.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/admin/todo` |
| `GET` | `/v1/admin/feedback` |
| `PUT` | `/v1/admin/feedback/:type/:id` |
| `GET` | `/v1/admin/users` |
| `GET` | `/v1/admin/users/:id` |
| `PUT` | `/v1/admin/users/:id/ban` |
| `PUT` | `/v1/admin/users/:id/quota` |
| `POST` | `/v1/admin/jobs/:id/retry` |
| `GET` | `/v1/admin/bank` |
| `GET` | `/v1/admin/settings` |
| `PUT` | `/v1/admin/settings/limits` |
| `PUT` | `/v1/admin/settings/budget` |
| `PUT` | `/v1/admin/settings/prices` |

**外部接口配置**：[请求校验与处理入口](../server/src/modules/admin/ai.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/admin/ai` |
| `POST` | `/v1/admin/ai/endpoints` |
| `PUT` | `/v1/admin/ai/endpoints/:id` |
| `DELETE` | `/v1/admin/ai/endpoints/:id` |
| `PUT` | `/v1/admin/ai/order` |
| `POST` | `/v1/admin/ai/endpoints/:id/test` |
| `PUT` | `/v1/admin/ai/thinking` |
| `GET` | `/v1/admin/ai/routes` |
| `PUT` | `/v1/admin/ai/routes` |

**内容排版**：[请求校验与处理入口](../server/src/modules/render/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/formula/:file` |
| `POST` | `/v1/render` |

**素材**：[请求校验与处理入口](../server/src/modules/assets/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/assets/:file` |

**法律文档**：[请求校验与处理入口](../server/src/modules/legal/routes.ts)。

| 方法 | 路径 |
| --- | --- |
| `GET` | `/v1/legal/:doc` |

## 联调与维护要求

不要将真实令牌、接口密钥或真实用户内容写进请求样例。测试使用明确的假凭据、临时数据库和服务替身；真实服务配置仅存放在自己的运行环境。

新增接口必须检查：未登录、他人资源、输入边界、重复请求、版本冲突、用户删除或切换后的异步返回。修改上传、删除或导出时还需验证文件和引用生命周期；修改任务与计量时验证成功、失败和结果未知的差异。

管理接口的Cookie仅用于管理台，创建／撤销和写操作核对来源；`x-admin-key`是保留给受控自动化的完整管理权限，不能发到小程序。具体配置见 [管理台说明](admin.md)，部署与备份见 [维护手册](runbook.md)。
