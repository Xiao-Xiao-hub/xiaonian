# 运行维护手册

适用于有相应授权的维护者。服务采用单进程 SQLite，以下均为通用示例，不包含线上主机、域名、账号或部署凭据。

## 日常检查

从源码根执行：

```bash
npm ci --prefix server
bash scripts/check.sh
```

Windows使用`npm.cmd ci --prefix server`和`.\scripts\check.ps1`。完整入口会执行类型检查、构建、后端与页面行为、小程序／管理台测试、原生编译、静态检查，以及运维和公开发布回归。WXML/WXSS编译需要微信开发者工具附带的编译器，使用`WCC_DIR`指定其目录；默认缺少编译器会使检查失败。

没有微信SDK的环境可显式执行`bash scripts/check.sh --skip-native`，Windows对应`.\scripts\check.ps1 -SkipNative`。公开仓库CI使用此模式，并明确标记原生编译尚未验证；发布前必须另行完成原生编译。脚本默认时区为`Asia/Shanghai`；跨时区回归可传`--timezone America/New_York`，Windows对应`-Timezone America/New_York`。

Linux分项命令：

```bash
npm run typecheck --prefix server
npm run build --prefix server
(cd server && node --test --test-concurrency=1 --import tsx ../tests/*.test.ts)
node --test --test-concurrency=1 tests/frontend*.test.cjs tests/admin*.test.mjs
bash scripts/compile_miniprogram.sh --required
python3 scripts/verify.py
python3 -m unittest discover -s tests -p '*_test.py'
```

构建包含地图布局生成，会重写`server/src/modules/learn/calc-map-graph.json`；检查构建后Git差异，确认只有预期变化。不要把重新生成的布局无条件覆盖到未完成的题库修改上。

## 容器部署

先参照 [后端运行](backend.md)准备自己的`server/.env`。本地示例端口是8788；现有Compose容器的监听、映射和健康探针使用8787，容器应设置`PORT=8787`。公开副本Compose已显式提供这个覆盖值。Compose生产覆盖示例使用`!reset`，需要Docker Compose 2.24或更新版本。

首次构建并启动：

```bash
docker compose up --build -d
```

生产模式另需`NODE_ENV=production`、关闭开发登录、设置微信登录凭据、足够随机的管理员密钥、精确HTTPS `ADMIN_ORIGIN`及持久数据库路径。执行前按自己的主机环境检查 [生产覆盖示例](../compose.production.example.yaml)和 [Nginx示例](../deploy/nginx.example.conf)：

```bash
docker compose -f compose.yaml -f compose.production.example.yaml up --build -d
```

生产覆盖采用主机网络、回环监听和`TRUST_PROXY=loopback`；它要求反向代理与API在同一主机网络内，并由代理重写转发头。不能将这套配置原样套在不同网络拓扑里。

公开副本的法律文件含“开发运行示例”标记。启用真实服务前填写真实运营主体、联系渠道、服务提供方与处理地域，更新法律文件、前后端隐私版本和微信平台相关配置；示例文件不可直接用于正式上线。

## 健康与故障定位

- `/health/live`用于判断进程存活；`/health/ready`用于判断应用是否就绪。两者不代表真实大模型、OCR或微信服务可用。
- 管理台查看失败任务、外部接口状态、匿名调用总账及计量错误。不要把“凭据已配置”当作已经联通，也不要把结果未知当作确定失败。
- 容器日志用`docker compose logs --tail 100 api`查看。分享日志前去除用户内容、令牌和配置；不要把完整日志收入源码包。
- 上传及流式请求的反向代理大小和超时应覆盖实际接口，不能只测健康检查后认为全部链路正常。

## 备份与恢复

数据库中含用户内容及外部接口配置；上传目录含用户图片和处理中导入文件，**备份也是私密数据，不能进入Git或源码包**。数据库单独在线备份可用`backup`命令，但完整恢复需要数据库和整个上传目录一致的快照。

先停止应用与后台任务，再执行完整备份。下例路径仅为独立备份目录示例，目标必须尚不存在：

```bash
python3 scripts/backup.py backup-bundle --source server/data/app.sqlite --uploads server/data/uploads --target /srv/xiaonian/backups/snapshot-001 --stopped
python3 scripts/backup.py restore-bundle --source /srv/xiaonian/backups/snapshot-001 --target /srv/xiaonian/restore/snapshot-001
```

`--stopped`表示维护者确认应用已停稳，脚本不会代为检查进程。恢复会校验文件摘要、SQLite完整性和外键，并写到全新目录；不会覆盖原库。不要直接复制运行中的SQLite文件，也不要删除它的WAL文件。

恢复验证时，将`DATABASE_PATH`和`UPLOAD_DIR`指向新恢复目录，检查资料原文、卡片、对话、作答和图片。确认无误后再采用该实例；验证失败时保留恢复目录供排查，原数据继续保留。容器运行还需让持久目录权限与容器用户一致。

`deploy/backup-nightly.sh`适用于Compose部署，需要维护者自行设置计划任务；它先停服务，备份后恢复服务，默认只保留最新14份成功快照。旧成功快照会被删除，失败目录保留待人工处理；使用前确认保留策略和备份目标。备份数量不等于固定保留天数，脚本存在也不代表备份计划已启用。

## 升级与回退

升级前保存完整备份和旧镜像／源码版本；在数据副本上验证数据库升级，再切换真实实例。应用启动执行迁移和兼容补列，不能通过清空迁移记录来跳过失败。

回退代码前确认旧代码能读取升级后的数据库。如果不能，恢复升级前的完整快照到新目录，并接受快照之后数据需要另行处理的事实；不要覆盖现有用户数据。升级期间只运行一个API实例。

## 源码交付

源码包只包含代码、必要素材、示例配置、测试和文档；不包含`.env`、数据库、上传数据、备份、依赖目录、私钥或个人开发工具配置。公开交付从已验证的Git提交生成，包内附逐文件SHA256清单，已有同名输出不会被覆盖。

先准备固定版本 **Gitleaks 8.30.1**，通过`GITLEAKS_BIN`指定可执行文件；随后在公开源码仓库根目录运行：

```bash
GITLEAKS_BIN=/path/to/gitleaks python3 scripts/package.py --ref HEAD --output /srv/downloads/xiaonian/xiaonian-source.zip
```

Windows PowerShell对应写法：

```powershell
$env:GITLEAKS_BIN = "C:\Tools\gitleaks.exe"
python scripts/package.py --ref HEAD --output "D:\Downloads\xiaonian\xiaonian-source.zip"
```

命令中的工具路径由维护者换成自己的安装位置。`--ref`和`--output`为必填项，不提供参数或使用旧的位置参数写法都会失败。脚本只读取指定提交，不打包本地未提交修改或未跟踪文件；指定提交内含敏感文件会阻止导出，不会静默跳过。内容检查或Gitleaks不通过、缺少Gitleaks时不会创建ZIP；已提交的旧`SHA256SUMS.json`也会被拒绝，清单只能由本次打包生成。

公开发布还需核对最终文件白名单、凭据内容扫描以及ZIP与提交的文件摘要一致；仅按扩展名排除不够。交付验证应在解压后的全新目录重新安装依赖和运行检查，而不是只在开发机器的旧依赖环境运行。

依赖升级后执行`node scripts/dependencies.mjs`更新许可盘点；脚本仅读取锁文件，不读取本机已安装包或注入当前时间，相同锁文件产生相同清单。同步核对 [第三方声明](../THIRD_PARTY_NOTICES.md) 的直接依赖和素材许可。

## 已知依赖风险

2026-10-20 核对锁文件时，`npm audit --omit=dev`报告3项中等风险，均来自同一依赖链`mammoth → argparse → sprintf-js`。上游[安全公告 GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)说明格式串精度可能触发异常，当前未列出修复版本。

本项目通过`mammoth.extractRawText`读取DOCX；代码检查与隔离容器中的合成DOCX验证均未加载`argparse`或`sprintf-js`，未发现当前文档解析入口可达该问题。这是当前调用路径的核对结果，不代表整个依赖没有风险。保留锁定版本；不要为清除审计提示直接执行`npm audit fix --force`回退到旧版。以后增加CLI调用或升级依赖时，应重新检查可达路径、上游修复版本和DOCX回归结果。
