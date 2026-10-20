# 后端运行与配置

后端使用 Node.js 24 和内置 `node:sqlite`。命令从源码根执行，`server/.env`仅用于自己的运行环境，不进入版本库。

## 两种启动方式

**隔离开发**用于学习代码和回归页面，全新数据目录默认不配置真实微信、大模型、判断或 OCR 服务：

```bash
npm ci --prefix server
bash scripts/dev-local.sh --no-watch
```

Windows：`npm.cmd ci --prefix server`，然后 `.\scripts\dev-local.ps1 -NoWatch`。默认监听 `127.0.0.1:8788`，数据保存在 `server/data/local-synthetic/`。需要新数据时通过 `--data-dir`／`-DataDir`指定全新目录，不覆盖原目录。该脚本跳过`.env`并清除从终端继承的外部服务凭据；不要用修改`.env`的方式尝试为隔离进程开启真实服务。

重复启动会保留数据库，包括曾在管理台保存的真实接口配置；这些接口仍可能发起真实调用。只做离线检查时使用全新数据目录，不在其管理台填写真实凭据。目录名称和合成数据标记不能证明数据库中没有真实接口配置。

**配置后运行**用于自己的联调环境，启动会加载`.env`：

```bash
npm ci --prefix server
cp server/.env.example server/.env
# 在本机编辑 server/.env，填写自己的配置。
cd server
npm run dev
```

示例文件使用8788端口；未设置`PORT`时，代码默认仍为8787。构建运行使用`npm run build`和`npm start`。已有`.env`时不要再次执行复制命令覆盖它。

## 最小配置

| 配置 | 示例／默认与用途 |
| --- | --- |
| `NODE_ENV` | 本地`development`；部署`production` |
| `HOST`、`PORT` | 示例`127.0.0.1:8788`；局域网真机联调需主动设置`HOST=0.0.0.0` |
| `DATABASE_PATH`、`UPLOAD_DIR` | 示例`./data/app.sqlite`、`./data/uploads`，相对`server/`工作目录解析 |
| `FORMULA_DIR` | 示例`./data/formulas`，公式图片缓存 |
| `DEV_LOGIN_ENABLED` | 本地可为`true`；生产强制`false` |
| `ADMIN_API_KEY` | 留空不启用管理访问；示例以注释保留，启用时填自己的随机值 |
| `ADMIN_ORIGIN` | 管理台实际访问的完整源地址，无路径、无末尾斜线；生产须HTTPS |
| `WECHAT_APP_ID`、`WECHAT_APP_SECRET` | 自己的小程序身份，仅在服务端配置密钥 |
| `TRUST_PROXY` | 默认`none`；仅同机可信反向代理正确重写转发头时使用`loopback` |

空的可选密钥应保持注释或不设置；不要写一个空的`ADMIN_API_KEY=`，它会因长度校验失败而阻止启动。准确的类型、范围和强制项以 [env.ts](../server/src/config/env.ts) 为准。

## 外部服务

生成和识图接口由`LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`及可选`LLM_EXTRA_BODY`提供初始配置。地址和模型标识必须使用自己已开通服务的值；示例中的`https://api.example.com/v1`、`your-model-id`仅为占位符。接口需兼容现有`/chat/completions`请求、结构化输出和所用场景的流式输出。

这些配置在第一次初始化数据库时用于播种接口；随后在管理台“AI 接口”配置地址、密钥、模型标识、识图能力、调用顺序、思考参数和场景路由。**修改`.env`不会更新数据库里已有的接口。** 初次未配置凭据也可以启动基础服务，之后在管理台添加接口。数据库保存接口密钥，所以数据库和备份也必须作为私密配置管理。

判断服务沿用`JEV_API_KEY`、`JEV_BASE_URL`和`JUDGE_PROVIDER`这些兼容变量名；`JUDGE_PROVIDER`支持`jev`（判断接口）、`llm`（大模型判断）、`jev_llm`（先判断接口，失败后大模型）。这些名称是协议标识，不是界面文案。

OCR可以配置`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`OCR_REGION`；未配置专用OCR时，需要配置可看图的大模型接口。`OCR_VISION_MODEL`仅用于首次播种识图接口。没有可用外部服务时，相关功能返回未配置／服务不可用，不会将失败当作已完成。

## 预算、任务与会话

- `DAILY_BUDGET_CNY`和`WEEKLY_BUDGET_CNY`设置默认日／周金额预算；当前默认3和12。金额按管理台价格表及成功操作实际记录的用量计算，**不是服务方结算账单**。
- `DAILY_SAFETY_CAP`默认500，用于阻止单日失控调用。旧`*_LIMIT`变量保留兼容统计，不应当成当前用户的主要预算规则。
- `JOB_CONCURRENCY`控制进程内后台任务并发；小内存环境建议从2开始。服务端任务状态可恢复，但外部请求结果未知时不能盲目重复调用。
- `SESSION_TTL_SECONDS`默认604800秒。用户令牌在数据库中仅保存摘要。管理员会话独立，闲置15分钟或最长8小时失效，服务重启后撤销。

## 文件与系统依赖

文本、Markdown和DOCX解析使用锁定依赖。PDF文本解析使用`unpdf`，扫描页转图片还依赖Poppler的`pdftoppm`工具；本地Linux可安装`poppler-utils`。公式中文需要可用的中文字体，例如系统安装的Noto CJK或文泉驿字体。字体不随本源码分发；Dockerfile已安装所需系统工具与字体。

程序启动会执行数据库升级及兼容补列。已有数据先完整备份，再运行新版本；不要手工清空迁移表、删除数据库或改旧迁移来解决升级失败。备份恢复和单实例部署见 [维护手册](runbook.md)。

## 快速排查

| 现象 | 先检查 |
| --- | --- |
| 无法启动或类型错误 | Node主版本是否24，是否在`server`安装了锁定依赖 |
| 微信登录失败 | 小程序AppID与服务端配置是否属于同一应用，开发登录是否被关闭 |
| 大模型未配置／接口不可用 | 当前启动是否为隔离模式；管理台是否有启用接口；自己的密钥、地址和能力是否匹配 |
| 改了`.env`模型设置仍不生效 | 数据库已有接口，去管理台更新 |
| 管理台登录被拒 | 密钥是否设置、访问源是否与`ADMIN_ORIGIN`一致、会话是否过期 |
| 扫描PDF失败或公式中文空白 | Poppler或系统中文字体是否安装 |
| 出现空数据库 | 实际工作目录及`DATABASE_PATH`是否指向原文件 |

接口与字段见 [API](api.md)，修改位置见 [代码地图](code-map.md)。
