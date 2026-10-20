# page-head

自定义导航页的页头：状态栏留白，一行和微信胶囊同高，左边大字标题加蓝色荧光笔底线，标题右边是插槽，最右边给胶囊让位。开发入口见[小程序说明](../../README.md)，公共样式见[app.wxss](../../app.wxss)。

## 用法

页面 json：

```json
{
  "navigationStyle": "custom",
  "usingComponents": { "page-head": "/components/page-head/index" }
}
```

页面 wxml（放在最前面，`.page` 外面，不然会多一层左右内边距）：

```html
<page-head title="随心记" tint="blue">
  <view class="chip">数学</view>
</page-head>
<view class="page ph-body">
  …页面内容…
</view>
```

## 属性

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `title` | String | `""` | 大字标题，空就只显示插槽 |
| `tint` | String | `""` | 顶部淡彩：`blue` / `yellow` / `mint` / `slate`，空为不加 |

## 插槽

一个默认插槽，排在标题右边、胶囊左边，可放切换、筛选小块等。插槽区域 `flex: 1`，内容横排居中对齐，放不下自己处理省略。

## 注意

- 必须在页面 json 里写 `"navigationStyle": "custom"`，否则会和原生导航栏叠两层。tab 页也一样。
- 高度按 `wx.getWindowInfo()` 的状态栏高和 `wx.getMenuButtonBoundingClientRect()` 的胶囊位置算；拿不到时按状态栏 20px、行高 44px、右边留 104px。
- 有 `tint` 时淡彩是绝对定位的一块（约 280px 高），后面的内容要包在 `.ph-body`（全局类：`position: relative; z-index: 1`）里，否则会被淡彩盖住。`.page.ph-body` 会去掉 `.page` 的底色和最小高度（页面底色由 `page` 本身给），不然淡彩被它盖住。
- 标题样式是全局类 `.ptitle`，不用组件也能单独用。
- 组件开了 `addGlobalClass`，插槽里能直接用 app.wxss 的公共类。
