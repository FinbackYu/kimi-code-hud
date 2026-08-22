# docs/showcase — HUD 展示素材

| 文件 | 作用 |
| --- | --- |
| `startup-page.html` | Kimi Code 启动页 1:1 像素复刻；加载 2s 后 HUD 行按真实 `renderHud()` 输出轮播（`?static` 关闭，点击状态栏暂停/继续） |
| `states-gallery.html` | 展示页：启动页 1:1 复刻（含对话与输入框），line 3 起堆叠核心 HUD 状态（`GALLERY_IDS` 挑选，无文字说明） |
| `render-states.mjs` | 状态定义 + 生成器；把各状态 ctx 喂给真实 `src/render.mjs`，ANSI 转 HTML |
| `hud-states.js` | 本地生成产物（勿手改、不入库），上面两个页面都从这里取 HUD 行 |

## 更新流程

HUD 样式或状态变更后：

```bash
node docs/showcase/render-states.mjs
```

脚本会打印每行可见字符数；normal 布局行超 200 字符会被 `renderHud` 自动降级为 compact，脚本以非零退出码报警。新增/调整状态：编辑 `STATES` 数组后重跑。

每次发布（bump `package.json`、`kimi.plugin.json` 与 `CHANGELOG.md`）必须重跑整条导出管线：

```bash
node docs/showcase/render-states.mjs && python3 docs/showcase/export-assets.py
```

重新生成公开仓库中的两张 PNG：`docs/media/hud-demo.png` 与 `docs/media/hud-states.png`，并随发布 commit 提交；确认头图 `hud-states.png` 标题栏显示新 HUD 版本、欢迎框 Version 字段与 `CAPABILITIES.md` 的 Kimi Code 基线一致。导出器会从 `kimi.plugin.json` 读取 `author`，以标准 PNG `tEXt` 块写入 `Author` 元数据。

如果像素已经正确、只需为现有两张 PNG 补齐或刷新作者元数据，可运行：

```bash
python3 docs/showcase/export-assets.py --metadata-only
```

该模式只重写 PNG 元数据，不启动浏览器，也不改变 `IDAT` 像素数据；重复运行结果一致。

## 截图导出

```bash
# 启动页（与原截图同尺寸 2938×860）
npx playwright screenshot --viewport-size=2938,860 \
  "docs/showcase/startup-page.html?scale=2&static" showcase.png

# 展示页长图
npx playwright screenshot --full-page --viewport-size=1469,690 \
  docs/showcase/states-gallery.html states-gallery.png

# 窗口元素 2x 导出：docs/media/hud-demo.png（startup-page 窗口）、
# docs/media/hud-states.png（README 头图，窗口四周带 56px L0 青色画布边距）。
# HUD 变更后需重跑本脚本并提交这两张公开 PNG
python3 docs/showcase/export-assets.py
```

`startup-page.html` 顶部静态版式改文字：编辑文件内 `CONFIG`。
