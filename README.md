# PDF Canvas 标注工具

基于 Canvas、Web Worker、IndexedDB、`pdfjs-dist` 与 `pdf-lib` 的 PDF 解析、渲染、标注和导出应用。

## 功能范围

- PDF 解析：在 Web Worker 中加载并解析 PDF，支持密码输入、空文件和损坏文件错误提示。
- PDF 渲染：PDF.js 将页面绘制到 OffscreenCanvas，主线程用 Canvas 覆盖层承载标注。
- 标注工具：支持画笔、半透明高亮、中文/英文文字和标注删除。
- PDF 导出：独立导出 Web Worker 中使用 pdf-lib 写入画笔/高亮，文字以透明 PNG 保真嵌入。
- 本地持久化：IndexedDB 保存 PDF、标注和最近文档；存储失败时保留当前会话数据并提示。
- 性能策略：IntersectionObserver 懒激活、离屏 Canvas 释放、缩放代次取消过期渲染、DPR 上限为 2。
- 异常处理：覆盖 Worker 错误、渲染取消、解析失败、密码取消、导出失败、存储配额不足等路径。

## 本地运行

```bash
npm install
npm run dev
```

打开浏览器显示的本地地址，选择任意 PDF；也可运行 `npm run sample` 生成 `public/sample.pdf` 作为验收样例。

## 验证命令

```bash
npm test
npm run build
npm run test:e2e
```

`npm test` 当前覆盖坐标变换、标注命中、文字栅格化和导出 PDF 有效性，共 14 项测试。`npm run test:e2e` 使用 Playwright 启动生产预览，验证非空页面像素、三种标注、导出 PDF 页数、刷新后 IndexedDB 恢复和 20 秒性能阈值。Playwright 首次运行时需要执行 `npx playwright install chromium`，Linux 还需安装其系统依赖。

## 操作说明

1. 点击“打开 PDF”或首页最近文档。
2. 选择画笔、高亮、文字或删除工具。
3. 使用颜色选择器更改标注颜色。
4. 使用缩放按钮或“适宽”调整页面。
5. 点击“导出 PDF”下载 `*-annotated.pdf`，原文件不会被覆盖。
6. “清除缓存”只删除当前浏览器 IndexedDB 中的当前 PDF 和标注。

## 目录

- `src/workers/pdf.worker.js`：PDF 解析、加密处理和离屏页面渲染。
- `src/workers/export.worker.js`：带标注 PDF 导出。
- `src/pdf-viewer.js`：页面生命周期、懒渲染、交互和持久化。
- `src/lib/annotations.js`：Canvas 标注绘制与命中检测。
- `src/lib/geometry.js`：PDF 用户空间与屏幕坐标转换。
- `src/lib/text-raster.js`：文字标注透明位图生成。
- `src/lib/exporter.js`：pdf-lib 导出逻辑。
- `src/lib/pdf-database.js`：IndexedDB 存储与内存降级。
- `scripts/e2e.mjs`：Playwright 端到端验收。
