# 晓念小程序前端

本目录由微信开发者工具直接导入。页面使用原生 JS、WXML、WXSS 和 JSON，没有前端打包框架。注册页面和分包以 [app.json](app.json) 为准；公共颜色、字号和间距以 [app.wxss](app.wxss) 为准。

## 连接后端

1. 在工程根安装后端依赖，并用 `scripts/dev-local.sh` 或 `scripts/dev-local.ps1` 启动本地服务。
2. 在微信开发者工具导入本目录，填写自己有权限使用的 AppID；不要借用他人的 AppID。
3. 开发版读取 [utils/config.js](utils/config.js) 的 `DEV_API_BASE_URL`，本机默认 `http://127.0.0.1:8788`。开发者工具本地设置开启“不校验合法域名”。
4. 开发登录使用固定 `DEV_LOGIN_KEY`；相同 key 对应同一个开发用户。体验版和正式版使用微信登录，需要后端配置自己的微信登录凭据。
5. 公开副本的 `API_BASE_URL` 留空。连接体验版／正式版前填自己的 HTTPS 服务地址（不带 `/v1`），并在微信公众平台配置 request、uploadFile、downloadFile 合法域名。

真机无法通过 `127.0.0.1` 访问电脑。手机和电脑应在同一局域网，将开发地址改为电脑的局域网地址，并采用 [后端运行说明](../docs/backend.md) 的配置启动方式让服务监听 `0.0.0.0`；隔离开发脚本固定监听回环地址。开发调试设置不能代替体验版／正式版的 HTTPS 和合法域名配置。

## 页面与公共逻辑

| 位置 | 职责 |
| --- | --- |
| `pages/notes`、`pages/deck`、`pages/learn`、`pages/talk`、`pages/profile` | 五个底部入口 |
| `pages/import`、`pages/brainstorm` | 文件导入与头脑风暴分包 |
| `pages/ask`、`pages/grade`、`pages/point`、`pages/map` | 解题、批改、知识点和地图 |
| `components/` | 页头、卡片、公式、空状态等可复用界面 |
| `utils/request.js`、`utils/auth.js`、`utils/session.js` | 请求、登录和当前会话 |
| `utils/api.js`、`utils/job.js` | API 封装、任务查询与等待状态 |
| `utils/config.js` | 产品名称、开发／正式后端地址和隐私版本 |

阅读一个页面时，先看 `.wxml` 的数据绑定，再看 `.js` 的事件与请求，最后看 `.wxss` 的局部样式。新增页面需要同时注册路由，公共组件通过页面 JSON 声明。

## 修改后检查

工程根执行 `bash scripts/check.sh`，并在微信开发者工具实际打开修改的页面。网络请求结束时，当前账号、页面和草稿可能已经改变；不能删掉现有过期响应判断来让代码看起来更短。操作原图、上传附件或整页批改时，还应测试切换草稿、离页、返回与删除。

可配置 `WCC_DIR` 指向微信开发者工具附带的编译器；详细要求见 [维护手册](../docs/runbook.md)。页面行为测试不验证实际布局，原生编译也不代替真机键盘、拍照、文件选择与滚动验证。
