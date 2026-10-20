/*
 * 静态资源地址：为页面构造项目图片等资源的访问地址。
 * 后端地址来自配置；不要把个人文件、鉴权凭证或临时路径放入公共资源地址。
 */
const { baseUrl } = require("./request");
// Public images served by GET /v1/assets/:file (server/assets): the mascot
// poses (xiaoli-hi.webp, xiaoli-smile.webp, xiaoli-think.webp, xiaoli-cheer.webp,
// xiaoli-face.webp, xiaoli-brainstorm.webp) and the 3D icons (ic-<name>.webp). They stay out of the
// 2 MB main package.
//
//   <image src="{{icon}}" webp="{{true}}" mode="aspectFit" binderror="..." />
//
// An <image> only shows a network WebP with webp="{{true}}". When the picture
// does not load, hide it (or show a plain coloured circle) rather than leave a
// broken image.
function asset(name) {
  return `${baseUrl().replace(/\/$/, "")}/v1/assets/${name}`;
}
module.exports = { asset };
