# 代码地图与维护约定

这份说明面向第一次接手项目的成员。先运行本地服务，再沿一个页面跟踪到接口和数据库；不需要一次读完整个工程。

## 推荐阅读顺序

1. [工程README](../README.md)：了解目录和启动方式。
2. [小程序app.json](../miniprogram/app.json)：找到页面和分包；从一个页面的WXML事件查到同名JS方法。
3. `miniprogram/utils/`：请求、当前会话、API调用与任务等待的公共逻辑。
4. [后端入口](../server/src/index.ts)：各服务如何创建、哪些模块注册了路由。
5. 对应业务的`routes.ts` → `service.ts` → [数据库实现](../server/src/shared/store.ts)。
6. 对应的测试文件：先看正常流程，再看失败、重复提交、版本变化和用户隔离的断言。

## 按修改目的找位置

| 想修改的内容 | 位置与注意点 |
| --- | --- |
| 页面文案与交互 | `miniprogram/pages/<页面>/`；WXML是结构、WXSS是样式、JS是状态和事件、JSON是组件声明 |
| 公共界面 | `miniprogram/components/`及`app.wxss`；优先复用已有组件和颜色尺寸变量 |
| 登录与请求 | `miniprogram/utils/`、`server/src/modules/auth/`；保留过期请求和账号切换保护 |
| 头像与昵称 | `miniprogram/pages/profile/`、`utils/profile.js` → `server/src/modules/account/routes.ts`、`profile.ts`；原生授权、昵称检查、本人头像存储与清除。对应 `frontend-user-profile.test.cjs`、`profile.test.ts` |
| 资料、卡片、对话、导入 | `server/src/modules/`对应领域；接口入口与业务处理分开阅读 |
| 大模型提示词／输出结构 | 对应模块的`prompts.ts`或`schema.ts`，以及`providers/`；同时核对字段校验 |
| 地图题库与判题 | `server/src/modules/learn/`；题目、答案、解析、图布局和判题各自分文件 |
| 数据库与预算 | `server/src/shared/store.ts`、`budget.ts`、`limits.ts`、`usage-ledger.ts` |
| 管理台 | `admin/`及`server/src/modules/admin/` |
| 公开协议页面 | `server/legal/`及`server/src/modules/legal/`；同步前后端隐私版本 |
| 运行与构建 | `server/package.json`、`server/Dockerfile`、`scripts/`和Compose配置 |

## 一个小改动怎样做

先找复现步骤和对应测试，再改最小范围。修改接口字段时一起改服务端校验、客户端调用、测试和[接口文档](api.md)。修改数据库时保留既有迁移链，写增量迁移或兼容升级，并用已有数据的副本验证升级；不要为了整理目录改数据表、存储键和协议标识。

新增页面使用已有组件和请求封装。一个操作发起后，用户可能已经离页、换账号、换草稿或编辑了原文；提交结果前需要重新核对操作所属身份、页面代际和版本。遇到这类保护代码，先读测试再调整，不把它当作无用重复。

注释解释职责、输入输出、状态变化和不能破坏的约束。显然的赋值不必逐行复述；复杂分支需要说明为什么存在。命名体现业务用途，测试描述用户行为和预期结果。

## 测试在哪里

| 测试 | 证明什么 |
| --- | --- |
| `tests/*.test.ts` | 后端接口、数据库、外部服务替身、页面与接口联动 |
| `tests/frontend*.test.cjs` | 小程序逻辑、状态切换及静态约束 |
| `tests/admin*.test.mjs` | 管理台显示、交互和会话行为 |
| `tests/operations_test.py` | 备份恢复、数据完整性与文件路径边界 |
| `tests/public_release_test.py` | 公开内容检查、敏感文件阻断、指定提交打包与ZIP清单一致性 |
| `tests/check_scripts_test.py` | 检查脚本的阶段顺序、失败停止与原生编译要求 |
| 微信原生编译与页面检查 | WXML/WXSS可编译、实际布局和设备交互；自动行为测试不能替代 |

先跑与修改相关的测试，再跑完整入口。完整检查、备份和交付要求见 [维护手册](runbook.md)。测试文件中的旧版本编号仅用于定位回归来源，不表示运行着另一套产品。
