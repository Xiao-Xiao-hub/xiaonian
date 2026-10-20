# 晓念

晓念随心记（简称“晓念”）是面向记录与学习的原生微信小程序。当前源码基线为 V4.2，包含随心记、卡片、学习、聊一聊、我的五个入口，以及独立后端和浏览器管理台。

公开源码仓库：[Xiao-Xiao-hub/xiaonian](https://github.com/Xiao-Xiao-hub/xiaonian)。

## 先了解项目

- **随心记与卡片**：保存原话、整理卡片、补充理解、收藏和标签、关联与回顾。
- **学习**：高数知识地图、练习与复测、资料学习、拍题解题、批改和错题整理。
- **对话与导入**：按场景展开对话，导入文字、图片、PDF 和 DOCX，将选中的卡片用于头脑风暴。
- **管理与维护**：配置外部服务、管理额度、处理反馈、查看任务和用量、备份与恢复。

技术栈为原生 JavaScript/WXML/WXSS、Node.js 24、TypeScript、Fastify 和 SQLite。管理台使用原生 HTML/CSS/JavaScript；无需单独构建前端。服务端按单进程运行，没有多实例数据库或跨端账号同步。

| 你要做什么 | 阅读入口 |
| --- | --- |
| 第一次运行 | 本页下面的步骤、[后端运行](docs/backend.md)、[小程序说明](miniprogram/README.md) |
| 看懂代码分工、从哪里修改 | [代码地图与维护约定](docs/code-map.md) |
| 了解模块和数据流 | [架构说明](docs/architecture.md) |
| 接口联调 | [接口契约](docs/api.md) |
| 了解 AI 的输入、输出与限制 | [AI 功能说明](docs/ai-features.md) |
| 配置管理台 | [管理台说明](docs/admin.md) |
| 部署、备份、恢复和升级 | [维护手册](docs/runbook.md) |
| 查看许可范围与第三方来源 | [版权说明](LICENSE.md)、[第三方声明](THIRD_PARTY_NOTICES.md) |

## 第一次本地运行

先安装 Node.js 24、npm 和 Python 3.12 或更新版本；小程序界面需要微信开发者工具。PDF 扫描页识别还需要 Poppler，公式中文需要系统中文字体，详见[后端运行](docs/backend.md)。下列命令从源码根目录执行。

```bash
npm ci --prefix server
bash scripts/dev-local.sh --no-watch
```

Windows 使用 PowerShell：

```powershell
npm.cmd ci --prefix server
.\scripts\dev-local.ps1 -NoWatch
```

浏览器访问 `http://127.0.0.1:8788/health/ready` 检查服务状态。隔离开发启动使用独立的合成数据目录和开发身份，**不会读取 `server/.env`，也不会继承终端中的外部服务凭据**。全新数据目录默认没有真实服务配置，可查看页面、保存手工内容和使用本地规则功能；需要大模型或 OCR 的功能不会被模拟为成功。

重复启动会保留该目录中的数据，包括曾在管理台填写的接口配置。若已添加真实接口，相关功能仍可能发起真实调用。只做离线检查时，用 `--data-dir`（Windows 为 `-DataDir`）指定全新目录，并且不在该目录的管理台填写真实凭据。

在微信开发者工具导入 `miniprogram/`，填写自己有权限使用的 AppID。开发版通过 `utils/config.js` 的 `DEV_API_BASE_URL` 连接本机；本地联调需在开发者工具中开启不校验合法域名。真机调试的局域网设置、体验版 HTTPS 地址与微信登录见[小程序说明](miniprogram/README.md)。公开副本不提供可直接连接的生产服务。

## 目录

```text
miniprogram/     小程序页面、组件、公共逻辑和随包素材
server/         接口服务、数据库、外部服务适配、公开素材与法律文档
admin/          同源浏览器管理台
scripts/        本地启动、检查、题库构建、备份和源码打包
tests/         接口、页面行为、管理台及运维回归测试
docs/           运行、架构、接口和维护说明
deploy/         通用反向代理示例与备份工具
```

## 验证修改

```bash
bash scripts/check.sh
```

Windows 对应 `.\scripts\check.ps1`。检查包括类型、构建、接口与页面行为、小程序静态依赖、运维与发布脚本，以及 WXML/WXSS 原生编译。默认必须具备微信编译器，缺少时检查失败；使用 `WCC_DIR` 指定编译器目录。

没有微信 SDK 的环境可以显式执行 `bash scripts/check.sh --skip-native`，Windows 对应 `.\scripts\check.ps1 -SkipNative`。公开仓库 CI 使用这一模式，结果仅覆盖源码与行为检查；发布前仍须完成严格原生编译，也需另行做真机验证。完整说明及分项命令见[维护手册](docs/runbook.md)。

自动测试使用临时数据库和服务替身，不能证明真实模型回答正确、实际账单一致或所有设备交互正常。连接真实服务前完成配置，修改后按涉及模块做开发者工具与真机验证。

## 维护与版权

本次源码整理使用 AI 辅助排查问题、整理代码与文档。

公开源码供查看和审阅，未授予额外商用授权。项目自身内容与第三方组件的许可分别见 [LICENSE.md](LICENSE.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。安装、运行和维护说明供有相应授权的成员使用，不改变这些授权范围。
