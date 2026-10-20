# 架构与数据流

当前实现为原生微信小程序、Fastify 模块化单体和 SQLite，另有同源管理台。模块按业务划分，外部调用集中在服务端；小程序不保存外部服务密钥。

```mermaid
flowchart TD
  Mini[微信小程序] --> API[HTTP API /v1]
  Console[浏览器管理台] --> Admin[管理员会话与管理接口]
  API --> Domain[卡片 / 对话 / 导入 / 学习 / 账号]
  Domain --> Jobs[持久任务与进程内执行器]
  Domain --> DB[(SQLite)]
  Jobs --> Router[外部服务路由]
  Router --> Generate[大模型生成与识图]
  Router --> Judge[判断服务]
  Router --> OCR[文字识别服务]
  Domain --> Math[本地数学判题与公式渲染]
  Domain --> Uploads[上传文件目录]
  Admin --> DB
  Admin --> Router
```

## 模块分工

| 领域 | 模块目录 | 负责什么 |
| --- | --- | --- |
| 卡片与随心记 | `cards`、`notes`、`resume` | 原话、结构化卡片、补充与关联、旧笔记兼容、回顾与接续 |
| 对话与工具 | `chat`、`mistakes` | 对话流、图片附件、解题与批改、历史和错题 |
| 导入与头脑风暴 | `imports`、`brainstorm` | 文件解析、确认原文、拆卡、选卡汇总与保存 |
| 学习 | `learn`、`study`、`review`、`study-time`、`materials` | 高数地图、程序判题、资料学习、复习与时长 |
| 身份与管理 | `auth`、`account`、`admin` | 用户会话、可选头像昵称、管理员会话、同意、导出注销、配置和统计 |
| 共用能力 | `jobs`、`safety`、`render`、`assets`、`legal` | 持久任务、心情与风险边界、排版、素材和法律文档 |

目录均位于 `server/src/modules/`。入口 [index.ts](../server/src/index.ts) 负责装配；`routes.ts`处理请求校验与鉴权，`service.ts`处理业务，必要时再拆同领域文件。`providers/`只负责外部协议和调用，`shared/`存放数据库、时间、预算、计量与共用错误。

## 三条主要数据流

**记录到卡片。** 用户保存原话后创建卡片；整理任务把原文转换为结构化内容。用户的原话和自己填写的理解与生成结果分开保存。后续编辑、合并、补充、删除都要保持归属、版本和来源关系，不把过期任务结果覆盖到新版本。

**资料到学习。** 文字或文件先形成材料／导入记录，识别结果供校对和确认；讲解、自测和拆卡引用被选定的原文。作答优先使用程序规则；无法可靠判定时返回不确定。学习地图的预置题判定走本地程序，不依赖远程生成服务。

**请求到任务。** 较长操作先写任务状态，再由进程内执行器处理；客户端按任务或业务记录恢复进度。流式对话使用 SSE 逐步输出，断开客户端连接不等于撤销服务端处理。幂等标识、内容版本和会话代际分别防止重复提交、覆盖新内容与跨账号回显。

## 沿实际操作跟读代码

先从页面事件找到请求，再沿路由进入服务，最后核对数据库写入和测试。以下两条流程均对应当前实现；表中的数据表是该动作直接写入的位置，建表与升级定义见 [store.ts](../server/src/shared/store.ts)。

| 操作与页面入口 | 请求 | 路由 → 服务 | 实际写入 | 对应测试 |
| --- | --- | --- | --- | --- |
| 保存随心记原话：[pages/notes/index.js](../miniprogram/pages/notes/index.js) 的 `save()` | `POST /v1/cards`，带 `text`、`clientId`、`origin` | [cards/routes.ts](../server/src/modules/cards/routes.ts) 校验身份和字段 → [cards/service.ts](../server/src/modules/cards/service.ts) 的 `CardService.create()` | `cards` 保存原话与卡片；`card_versions` 保存创建记录及幂等标识；`events` 记录创建事件 | [frontend-v2-notes.test.cjs](../tests/frontend-v2-notes.test.cjs)：保存、失败保留草稿及切换账号；[v2-cards.test.ts](../tests/v2-cards.test.ts)：创建、查询、原话保护与用户隔离 |
| 同意处理心情内容：[pages/mood-consent/index.js](../miniprogram/pages/mood-consent/index.js) 的 `agree()` | `PUT /v1/me/mood-consent`；儿童账号带 `guardian: true` | [safety/routes.ts](../server/src/modules/safety/routes.ts) 校验身份和请求 → [safety/mood.ts](../server/src/modules/safety/mood.ts) 的 `MoodService.consent()` | 更新 `users.data` 中的 `moodConsentAt`；儿童账号同时记录监护人对心情内容的单独同意 | [frontend-mood.test.cjs](../tests/frontend-mood.test.cjs)：同意后返回原页面；[v4-consent.test.ts](../tests/v4-consent.test.ts)：监护人要求、重复同意与记录读取 |
| 编辑个人资料：[pages/profile/index.js](../miniprogram/pages/profile/index.js) 的 `saveProfile()` | `PATCH /v1/me/profile` 或 multipart `POST /v1/me/profile`；头像用鉴权 `GET` 下载 | [account/routes.ts](../server/src/modules/account/routes.ts) 校验本人会话和请求 → [account/profile.ts](../server/src/modules/account/profile.ts) 检查新版同意、保存资料、回收旧文件 | `users.data` 的昵称和头像引用；头像文件在本人上传目录 `profile/` 中，不进入材料表 | [frontend-user-profile.test.cjs](../tests/frontend-user-profile.test.cjs)：审核、取消、切换与跳过；[profile.test.ts](../tests/profile.test.ts)：账户隔离、文件校验、注销与恢复 |

保存卡片之后，入口装配的回调还会交给 [CardTidyService](../server/src/modules/cards/tidy.ts) 尝试创建整理任务，任务条件满足时写入 `jobs`。原话已保存与整理已完成是两个状态；整理不可用时不能丢掉原话。心情同意流程只更新同意记录，本身不调用大模型。

## 数据与计量

SQLite 的建表、升级和兼容补列集中在 [store.ts](../server/src/shared/store.ts)。从已有数据升级必须经过原迁移链；不要删除历史迁移或修改存储标识来整理品牌文字。

业务数据按用户隔离。资料版本、卡片、对话、复习、任务等保存正文或派生内容；个人额度凭证和成功消耗记录用于日／周预算；匿名调用总账记录每次外部网络尝试，不保存学习正文。三种记录的用途不同，不能简单合并或用调用次数推算实付账单。

当前用户额度按管理台价格表计算成功操作的金额预算，另有每日安全次数上限。账单仍需与服务方核对。复习、额度与业务日期按北京时间处理；界面“今天／昨天”等展示可以按设备本地日期显示。

上传目录保存资料、聊天图片、个人头像和处理中导入文件；同一学习图片可能被多个业务对象引用，只有最后一个引用消失后才能删除。头像单独保存在本人 `profile/` 子目录，在 `users.data` 保存引用，使用专门的鉴权上传／读取接口，不进入学习资料或 AI 处理链。完整备份必须包括数据库和整个上传目录；公式缓存可以重新生成。

## 维护边界

- 一个 API 进程对应一个本地 SQLite 数据库；限流、任务执行和管理员会话包含进程内状态，不支持多个进程共享数据库并行提供服务。
- 管理台是单一管理员身份，用户账号与管理员会话分离；没有员工角色系统。
- 外部接口由适配器隔离，但更换服务仍需验证结构化输出、流式输出、识图和错误处理。
- Web/H5 身份绑定、分布式任务队列、多实例高可用均未实现。
- 自动测试覆盖程序行为；真实识别效果、真实设备体验和服务方账单需要单独核实。

按模块定位文件和修改步骤见 [代码地图](code-map.md)，运行与配置见 [后端运行](backend.md)。
