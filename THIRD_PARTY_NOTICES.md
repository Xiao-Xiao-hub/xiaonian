# 第三方依赖与素材声明

本声明记录实际使用的依赖与素材。项目自身内容的使用范围见 [LICENSE.md](LICENSE.md)；第三方各自的许可不受该文件替代。

## npm依赖

安装使用`server/package-lock.json`锁定版本。完整依赖盘点见 [dependencies.json](docs/dependencies.json)，下面列出直接依赖及公式字体依赖；许可字段来自锁文件声明，不是法律兼容性认证。源码包不包含`node_modules`。

| 依赖 | 锁定版本 | 声明许可 | 用途 |
| --- | --- | --- | --- |
| `@fastify/cors` | 10.1.0 | MIT | 跨源控制 |
| `@fastify/helmet` | 13.1.1 | MIT | HTTP响应头 |
| `@fastify/multipart` | 10.1.2 | MIT | 文件上传 |
| `@fastify/rate-limit` | 10.3.0 | MIT | 请求限流 |
| `@resvg/resvg-js` | 2.6.2 | MPL-2.0 | 公式图片渲染 |
| `@xmldom/xmldom` | 0.8.15 | MIT | 文档XML解析 |
| `fastify` | 5.12.5 | MIT | HTTP服务 |
| `jszip` | 3.10.2 | (MIT OR GPL-3.0-or-later) | DOCX压缩包读取 |
| `mammoth` | 1.13.0 | BSD-2-Clause | DOCX文字提取 |
| `marked` | 18.0.14 | MIT | Markdown解析 |
| `mathjax` | 4.1.3 | Apache-2.0 | 公式排版 |
| `mathjs` | 15.2.0 | Apache-2.0 | 本地数学计算 |
| `unpdf` | 1.8.1 | MIT | PDF文字提取 |
| `zod` | 3.25.76 | MIT | 输入和输出结构校验 |
| `@dagrejs/dagre` | 3.1.1 | MIT | 地图图布局构建 |
| `@types/node` | 24.13.6 | MIT | Node类型声明 |
| `prettier` | 3.6.2 | MIT | 代码格式工具 |
| `tsx` | 4.23.15 | MIT | 开发与测试执行 |
| `typescript` | 5.9.3 | Apache-2.0 | 类型检查与编译 |
| `@mathjax/mathjax-newcm-font` | 4.1.3 | Apache-2.0 | 公式字体 |

分发依赖包、构建产物或容器镜像时，应保留各包原有LICENSE／NOTICE和版权声明；修改第三方包时记录来源及修改。公式渲染依赖包含MPL-2.0声明，涉及其源码文件修改时须遵循原许可。JSZip声明提供MIT或GPL许可选择，使用其MIT许可时仍须保留原许可文本。系统中文字体不随本源码包分发；Docker构建安装的字体和系统工具依各自许可分发。

## 图标与形象

`server/assets/ic-*.webp`来自 [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji)，使用MIT许可；本项目进行了尺寸压缩和WebP格式转换。其许可全文如下：

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`server/assets/xiaoli-*.webp`及`miniprogram/assets/xiaoli/hi.webp`为本项目使用AI图像工具制作的“小狸”形象。随包线条图标与纸片装饰由项目脚本绘制。其依法可享有的权利适用项目版权声明。

## 方法参考

分层提示、先引导后讲解和间隔复习参考公开教学方法，包括 [OATutor](https://github.com/CAHLR/OATutor)、[MathDial](https://github.com/eth-nlped/mathdial)的研究思路和Leitner复习方法。这些属于方法参考，不表示本项目复制了其代码、提示词或数据，也不将研究仓库的许可套用于本项目。公开源码不附带课程原件、外部作品源码或研究阶段收集的网页图片。
