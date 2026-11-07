"use strict"

// 桌面版（GUI）入口。宿主只接受 .cjs/.js 作为 GUI 入口，运行时提供 @opencode/plugin/gui，
// 因此这里不需要构建步骤，也不要把文件改成 TS 或 ESM。
const { Plugin, Style } = require("@opencode/plugin/gui")

// 宿主把标题/加粗绑在 --v2-text-text-base 上，而桌面主题的 --markdown-* 多为派生出的高亮度值；
// 这里直接钉 TUI 默认主题（opencode, v2）的 markdown 配色，让两端观感一致。
// 代价：markdown 颜色不再跟随桌面主题，换主题时正文变、这些角色不变。
// 选择器重复一次 [data-component="markdown"] 是为了压过宿主 markdown.css 的嵌套规则特异性。
const markdownColors = `
:root[data-color-scheme="dark"] {
  --hud-md-heading: #9d7cd8;
  --hud-md-strong: #f5a742;
  --hud-md-emph: #e5c07b;
  --hud-md-code: #7fd88f;
  --hud-md-quote: #e5c07b;
  --hud-md-item: #fab283;
  --hud-md-enum: #56b6c2;
}

:root[data-color-scheme="light"] {
  --hud-md-heading: #d68c27;
  --hud-md-strong: #d68c27;
  --hud-md-emph: #b0851f;
  --hud-md-code: #3d9a57;
  --hud-md-quote: #b0851f;
  --hud-md-item: #3b7dd8;
  --hud-md-enum: #318795;
}

[data-component="markdown"][data-component="markdown"] :is(h1, h2, h3, h4, h5, h6) {
  color: var(--hud-md-heading);
}

[data-component="markdown"][data-component="markdown"] :is(strong, b) {
  color: var(--hud-md-strong);
}

[data-component="markdown"][data-component="markdown"] :is(em, i) {
  color: var(--hud-md-emph);
}

[data-component="markdown"][data-component="markdown"] :not(pre) > code:not([data-inline-code-kind]) {
  color: var(--hud-md-code);
  background: color-mix(in oklch, var(--hud-md-code) 8%, transparent);
}

[data-component="markdown"][data-component="markdown"] blockquote {
  color: var(--hud-md-quote);
  border-inline-start-color: var(--hud-md-quote);
}

[data-component="markdown"][data-component="markdown"] ul > li::marker {
  color: var(--hud-md-item);
}

[data-component="markdown"][data-component="markdown"] ol > li::marker {
  color: var(--hud-md-enum);
}
`

module.exports = Plugin.define({
  setup(ctx) {
    ctx.add(Style, markdownColors)
  },
})
