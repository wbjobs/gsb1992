# PDF Canvas 标注工具

基于 Canvas、Web Worker、IndexedDB、`pdfjs-dist` 和 `pdf-lib` 的前端 PDF 解析、渲染、标注与导出应用。

## 功能

- 使用 `pdfjs-dist` 在 Web Worker 中解析 PDF，并渲染到 OffscreenCanvas。
- 使用 Canvas 覆盖层绘制画笔、半透明高亮和文字标注。
- 标注坐标存储为 PDF 用户空间坐标，支持页面缩放和旋转。
- 使用 IndexedDB 按文档持久化标注；IndexedDB 不可用时自动降级到内存。
- 使用 `pdf-lib` 将画笔和高亮作为矢量内容写入导出 PDF。
- 文字标注栅格化为透明整页 PNG 后嵌入，保证中文等字体可随 PDF 导出。
- IntersectionObserver 仅激活视口附近页面；离屏页面释放 Canvas 显存。
- 快速缩放时通过渲染代次取消过期任务，避免旧画面回写。
- 对无效文件、解析失败、Worker 错误、渲染取消、导出失败和存储失败给出状态提示。

## 本地运行

```bash
npm install
npm run dev
```

## 验证

```bash
npm test
npm run build
```

当前自动化测试覆盖 PDF 坐标变换、标注命中、标注记录创建和导出 PDF 有效性。

## 操作说明

1. 点击“打开 PDF”选择文件。
2. 选择画笔、高亮、文字或删除工具。
3. 使用颜色选择器调整标注颜色。
4. 使用缩放按钮或“适宽”调整视图。
5. 点击“导出 PDF”下载带标注的新文件，原文件不会被覆盖。

## 主要目录

- `src/workers/pdf.worker.js`：PDF 解析与离屏渲染 Worker。
- `src/pdf-viewer.js`：页面生命周期、懒渲染和标注交互。
- `src/lib/annotations.js`：标注绘制与命中检测。
- `src/lib/geometry.js`：PDF 坐标和屏幕坐标转换。
- `src/lib/exporter.js`：带标注 PDF 导出。
- `src/lib/text-raster.js`：文字标注透明位图生成。
- `src/lib/pdf-database.js`：IndexedDB 存储和内存降级。
