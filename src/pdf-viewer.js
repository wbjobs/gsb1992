import {
  createAnnotation,
  drawAnnotation,
  findAnnotationAt,
  redrawAnnotationLayer
} from './lib/annotations';
import { normalizePdfRect, viewportPointToPdfPoint } from './lib/geometry';
import { PdfDatabase, debounce } from './lib/pdf-database';
import { exportAnnotatedPdf } from './lib/exporter';
import { createTextAnnotation, rasterizePageText } from './lib/text-raster';

export class PdfViewer {
  constructor(elements) {
    this.elements = elements;
    this.database = new PdfDatabase();
    this.worker = null;
    this.requestId = 0;
    this.loadToken = 0;

    this.fileName = '';
    this.documentId = '';
    this.sourceBytes = null;
    this.pageMetas = [];
    this.annotationsByPage = {};
    this.pages = new Map();

    this.scale = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.currentTool = 'pen';
    this.activeStroke = null;
    this.activeEditor = null;

    this.observer = null;
    this.persistAnnotations = debounce(() => this.saveAnnotations(), 350);
  }

  init() {
    const {
      fileInput,
      emptyFileInput,
      exportButton,
      zoomInButton,
      zoomOutButton,
      fitWidthButton,
      colorPicker,
      toolButtons
    } = this.elements;

    fileInput.addEventListener('change', (event) => this.handleFileSelection(event));
    emptyFileInput.addEventListener('change', (event) => this.handleFileSelection(event));
    exportButton.addEventListener('click', () => this.exportPdf());
    zoomInButton.addEventListener('click', () => this.setScale(this.scale + 0.15));
    zoomOutButton.addEventListener('click', () => this.setScale(this.scale - 0.15));
    fitWidthButton.addEventListener('click', () => this.fitWidth());
    colorPicker.addEventListener('change', () => {
      this.currentColor = colorPicker.value;
    });
    this.currentColor = colorPicker.value;

    toolButtons.forEach((button) => {
      button.addEventListener('click', () => this.selectTool(button.dataset.tool, button));
    });

    window.addEventListener('resize', debounce(() => {
      if (this.pageMetas.length) {
        this.renderVisiblePages();
      }
    }, 150));

    this.setStatus('就绪');
  }

  async handleFileSelection(event) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
      this.showError('请选择有效的 PDF 文件');
      return;
    }

    try {
      this.setStatus(`正在解析 ${file.name}…`);
      await this.loadDocument(file);
    } catch (error) {
      this.showError(error.message || 'PDF 解析失败');
    }
  }

  async loadDocument(file) {
    if (file.size === 0) {
      throw new Error('文件为空，无法解析 PDF');
    }

    if (
      typeof Worker === 'undefined' ||
      !HTMLCanvasElement.prototype.transferControlToOffscreen
    ) {
      throw new Error('当前浏览器不支持 Web Worker 或 OffscreenCanvas');
    }

    const token = ++this.loadToken;
    this.terminateWorker();
    this.resetDocumentState();
    this.elements.exportButton.disabled = true;

    const bytes = new Uint8Array(await file.arrayBuffer());
    this.sourceBytes = bytes;
    this.fileName = file.name;
    this.documentId = this.createDocumentId(file, bytes);

    this.worker = new Worker(new URL('./workers/pdf.worker.js', import.meta.url), {
      type: 'module'
    });
    this.worker.onmessage = (event) => {
      if (token === this.loadToken) {
        this.handleWorkerMessage(event.data);
      }
    };
    this.worker.onerror = (event) => {
      if (token === this.loadToken) {
        this.showError(event.message || 'PDF Worker 发生错误');
      }
    };

    try {
      this.annotationsByPage = await this.database.getAnnotations(this.documentId);
    } catch {
      this.annotationsByPage = {};
    }

    const transferBytes = bytes.slice();
    this.postWorkerMessage('load', { bytes: transferBytes.buffer }, [transferBytes.buffer]);
  }

  handleWorkerMessage(message) {
    if (message.type === 'password-required') {
      this.showError('暂不支持需要密码的加密 PDF');
      return;
    }

    if (message.type === 'loaded') {
      this.pageMetas = message.pages;
      this.preparePages();
      this.elements.emptyStateElement.classList.add('hidden');
      this.elements.viewerElement.classList.remove('hidden');
      this.setStatus(`已加载 ${this.pageMetas.length} 页`);
      this.updateZoomLabel();
      this.fitWidth();
      for (const page of this.pages.values()) {
        this.observer.observe(page.shell);
      }
      this.elements.exportButton.disabled = false;
      return;
    }

    if (message.type === 'rendered') {
      this.markPageRendered(message.pageNumber);
      return;
    }

    if (message.type === 'error' && !isCancelledOrPasswordError(message)) {
      if (message.pageNumber) {
        const page = this.pages.get(message.pageNumber);
        if (page?.loading) {
          page.loading.hidden = true;
        }
      }
      this.showError(message.message);
    }
  }

  resetDocumentState() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.elements.viewerElement.innerHTML = '';
    this.pages.clear();
    this.pageMetas = [];
    this.annotationsByPage = {};
    this.activeStroke = null;
    this.activeEditor = null;
  }

  terminateWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  createDocumentId(file, bytes) {
    const sample = [
      file.name,
      file.size,
      file.lastModified,
      bytes[0],
      bytes[Math.min(bytes.length - 1, 1024)],
      bytes[bytes.length - 1]
    ].join(':');

    let hash = 5381;
    for (const char of sample) {
      hash = (hash * 33) ^ char.charCodeAt(0);
    }
    return `pdf-${(hash >>> 0).toString(16)}-${file.size}`;
  }

  postWorkerMessage(type, payload = {}, transfer = []) {
    const requestId = ++this.requestId;
    this.worker.postMessage({ type, requestId, ...payload }, transfer);
    return requestId;
  }

  preparePages() {
    this.elements.viewerElement.innerHTML = '';
    this.pages.clear();

    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number(entry.target.dataset.pageNumber);
          const page = this.pages.get(pageNumber);
          if (!page) {
            continue;
          }

          page.visible = entry.isIntersecting;
          if (entry.isIntersecting) {
            this.activatePage(page);
            this.requestPageRender(page);
          } else {
            this.deactivatePage(page);
            this.cancelPageRender(page);
          }
        }
      },
      { root: this.elements.viewerElement, rootMargin: '600px', threshold: 0.01 }
    );

    const fragment = document.createDocumentFragment();

    for (const meta of this.pageMetas) {
      const shell = document.createElement('div');
      shell.className = 'page-shell';
      shell.dataset.pageNumber = String(meta.pageNumber);

      const baseCanvas = document.createElement('canvas');
      baseCanvas.className = 'page-canvas';
      baseCanvas.setAttribute('role', 'img');
      baseCanvas.setAttribute('aria-label', `第 ${meta.pageNumber} 页`);

      const annotationCanvas = document.createElement('canvas');
      annotationCanvas.className = 'annotation-canvas';

      const draftCanvas = document.createElement('canvas');
      draftCanvas.className = 'annotation-canvas';
      draftCanvas.style.pointerEvents = 'none';

      const loading = document.createElement('div');
      loading.className = 'page-loading';
      loading.textContent = '渲染中…';

      const pageNumber = document.createElement('div');
      pageNumber.className = 'page-number';
      pageNumber.textContent = `${meta.pageNumber} / ${this.pageMetas.length}`;

      shell.append(baseCanvas, annotationCanvas, draftCanvas, loading, pageNumber);
      fragment.append(shell);

      const page = {
        meta,
        shell,
        baseCanvas,
        annotationCanvas,
        draftCanvas,
        draftContext: draftCanvas.getContext('2d'),
        base: baseCanvas.transferControlToOffscreen(),
        loading,
        visible: false,
        renderedScale: null,
        baseTransferred: false,
        active: false
      };

      this.bindAnnotationEvents(page);
      this.pages.set(meta.pageNumber, page);
      this.applyPageSize(page);
    }

    this.elements.viewerElement.append(fragment);

    this.updatePageIndicator();
  }

  applyPageSize(page) {
    const width = Math.max(1, Math.round(page.meta.width * this.scale));
    const height = Math.max(1, Math.round(page.meta.height * this.scale));

    page.shell.style.width = `${width}px`;
    page.shell.style.height = `${height}px`;
    page.baseCanvas.style.width = `${width}px`;
    page.baseCanvas.style.height = `${height}px`;
    page.annotationCanvas.style.width = `${width}px`;
    page.annotationCanvas.style.height = `${height}px`;
    page.draftCanvas.style.width = `${width}px`;
    page.draftCanvas.style.height = `${height}px`;
    if (page.active) {
      page.annotationCanvas.width = Math.ceil(width * this.dpr);
      page.annotationCanvas.height = Math.ceil(height * this.dpr);
      page.draftCanvas.width = Math.ceil(width * this.dpr);
      page.draftCanvas.height = Math.ceil(height * this.dpr);
    } else {
      page.annotationCanvas.width = 1;
      page.annotationCanvas.height = 1;
      page.draftCanvas.width = 1;
      page.draftCanvas.height = 1;
    }

    this.redrawStaticAnnotations(page);
    this.clearDraft(page);
  }

  activatePage(page) {
    if (page.active) {
      return;
    }

    page.active = true;
    this.applyPageSize(page);
  }

  deactivatePage(page) {
    if (!page.active) {
      return;
    }

    page.active = false;
    page.renderedScale = null;
    page.annotationCanvas.width = 1;
    page.annotationCanvas.height = 1;
    page.draftCanvas.width = 1;
    page.draftCanvas.height = 1;
    this.postWorkerMessage('release-canvas', { pageNumber: page.meta.pageNumber });
  }

  requestPageRender(page) {
    if (page.renderedScale === this.scale) {
      return;
    }

    page.loading.hidden = false;
    if (!page.baseTransferred) {
      this.postWorkerMessage(
        'init-canvas',
        { pageNumber: page.meta.pageNumber, canvas: page.base },
        [page.base]
      );
      page.baseTransferred = true;
    }

    this.postWorkerMessage('render', {
      pageNumber: page.meta.pageNumber,
      scale: this.scale,
      dpr: this.dpr
    });
  }

  cancelPageRender(page) {
    if (page.renderedScale === this.scale) {
      return;
    }

    page.loading.hidden = true;
    this.postWorkerMessage('cancel-render', { pageNumber: page.meta.pageNumber });
  }

  markPageRendered(pageNumber) {
    const page = this.pages.get(pageNumber);
    if (!page) {
      return;
    }

    page.renderedScale = this.scale;
    page.loading.hidden = true;
    this.applyPageSize(page);
  }

  renderVisiblePages() {
    for (const page of this.pages.values()) {
      if (page.visible) {
        this.requestPageRender(page);
      }
    }
  }

  setScale(nextScale) {
    if (!this.pageMetas.length) {
      return;
    }

    this.scale = Math.min(4, Math.max(0.4, Number(nextScale.toFixed(2))));
    this.updateZoomLabel();

    for (const page of this.pages.values()) {
      this.applyPageSize(page);
      if (page.visible) {
        this.requestPageRender(page);
      }
    }
  }

  fitWidth() {
    if (!this.pageMetas.length) {
      return;
    }

    const availableWidth = Math.max(240, this.elements.viewerElement.clientWidth - 56);
    this.setScale(availableWidth / this.pageMetas[0].width);
  }

  updateZoomLabel() {
    this.elements.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
  }

  bindAnnotationEvents(page) {
    const canvas = page.annotationCanvas;

    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      this.handlePointerDown(page, event);
    });

    canvas.addEventListener('pointermove', (event) => {
      this.handlePointerMove(page, event);
    });

    canvas.addEventListener('pointerup', (event) => {
      this.handlePointerUp(page, event);
    });

    canvas.addEventListener('pointercancel', () => {
      this.cancelDraft(page);
    });
  }

  handlePointerDown(page, event) {
    if (this.activeEditor) {
      this.commitTextEditor();
    }

    const point = this.eventToPdfPoint(page, event);

    if (this.currentTool === 'eraser') {
      this.eraseAt(page, point);
      return;
    }

    if (this.currentTool === 'text') {
      this.openTextEditor(page, point, event);
      return;
    }

    if (this.currentTool === 'pen') {
      this.activeStroke = {
        page,
        annotation: createAnnotation({
          type: 'pen',
          pageNumber: page.meta.pageNumber,
          color: this.currentColor,
          lineWidth: 2.5,
          points: [point]
        })
      };
      this.drawDraft(page, this.activeStroke.annotation);
      return;
    }

    if (this.currentTool === 'highlight') {
      this.activeStroke = {
        page,
        start: point,
        current: point,
        annotation: createAnnotation({
          type: 'highlight',
          pageNumber: page.meta.pageNumber,
          color: this.currentColor,
          rect: normalizePdfRect(point, point)
        })
      };
    }
  }

  handlePointerMove(page, event) {
    if (!this.activeStroke || this.activeStroke.page !== page) {
      return;
    }

    const point = this.eventToPdfPoint(page, event);

    if (this.activeStroke.annotation.type === 'pen') {
      const previous = this.activeStroke.annotation.points.at(-1);
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 0.35 / this.scale) {
        return;
      }

      this.activeStroke.annotation.points.push(point);
      this.drawDraft(page, this.activeStroke.annotation);
      return;
    }

    if (this.activeStroke.annotation.type === 'highlight') {
      this.activeStroke.current = point;
      this.activeStroke.annotation.rect = normalizePdfRect(this.activeStroke.start, point);
      this.drawDraft(page, this.activeStroke.annotation);
    }
  }

  handlePointerUp(page) {
    if (!this.activeStroke || this.activeStroke.page !== page) {
      return;
    }

    const { annotation } = this.activeStroke;

    if (annotation.type === 'pen' && annotation.points.length >= 2) {
      this.addAnnotation(page, annotation);
    }

    if (annotation.type === 'highlight') {
      const { width, height } = annotation.rect;
      if (width >= 2 && height >= 2) {
        this.addAnnotation(page, annotation);
      }
    }

    this.cancelDraft(page);
  }

  addAnnotation(page, annotation) {
    const key = String(page.meta.pageNumber);
    this.annotationsByPage[key] ??= [];
    this.annotationsByPage[key].push(annotation);
    this.redrawStaticAnnotations(page);
    this.persistAnnotations();
    this.setStatus(`第 ${page.meta.pageNumber} 页标注已更新`);
  }

  eraseAt(page, point) {
    const key = String(page.meta.pageNumber);
    const annotations = this.annotationsByPage[key] ?? [];
    const hit = findAnnotationAt(annotations, point, 7 / this.scale);

    if (!hit) {
      return;
    }

    this.annotationsByPage[key] = annotations.filter((annotation) => annotation.id !== hit.id);
    this.redrawStaticAnnotations(page);
    this.persistAnnotations();
    this.setStatus(`已删除第 ${page.meta.pageNumber} 页的一个标注`);
  }

  eventToPdfPoint(page, event) {
    const rect = page.annotationCanvas.getBoundingClientRect();

    return viewportPointToPdfPoint(
      [event.clientX - rect.left, event.clientY - rect.top],
      page.meta.baseTransform,
      this.scale
    );
  }

  redrawStaticAnnotations(page) {
    const annotations = this.annotationsByPage[String(page.meta.pageNumber)] ?? [];
    redrawAnnotationLayer(
      page.annotationCanvas,
      annotations,
      page.meta.baseTransform,
      this.scale,
      this.dpr
    );
  }

  drawDraft(page, annotation) {
    const context = page.draftContext;
    const transform = page.meta.baseTransform.map((value) => value * this.scale);

    if (annotation.type === 'pen') {
      if (!annotation.points.length) {
        return;
      }

      const [a, b, c, d, e, f] = transform;
      context.setTransform(
        this.dpr * a,
        this.dpr * b,
        this.dpr * c,
        this.dpr * d,
        this.dpr * e,
        this.dpr * f
      );
      context.strokeStyle = annotation.color;
      context.lineWidth = annotation.lineWidth;
      context.lineCap = 'round';
      context.lineJoin = 'round';

      if (annotation.points.length === 2) {
        context.beginPath();
        context.moveTo(annotation.points[0][0], annotation.points[0][1]);
        context.lineTo(annotation.points[1][0], annotation.points[1][1]);
        context.stroke();
        return;
      }

      const start = annotation.points.at(-2);
      const end = annotation.points.at(-1);
      context.beginPath();
      context.moveTo(start[0], start[1]);
      context.lineTo(end[0], end[1]);
      context.stroke();
      return;
    }

    this.clearDraft(page);
    drawAnnotation(context, annotation, transform, this.dpr);
  }

  clearDraft(page) {
    const context = page.draftContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, page.draftCanvas.width, page.draftCanvas.height);
  }

  cancelDraft(page) {
    this.activeStroke = null;
    this.clearDraft(page);
  }

  openTextEditor(page, point, event) {
    const rect = page.annotationCanvas.getBoundingClientRect();
    const input = document.createElement('input');
    input.className = 'text-editor';
    input.type = 'text';
    input.placeholder = '输入文字';
    input.maxLength = 500;
    input.style.left = `${event.clientX - rect.left}px`;
    input.style.top = `${event.clientY - rect.top - 18 * this.scale}px`;
    input.style.fontSize = `${14 * this.scale}px`;

    this.activeEditor = {
      page,
      point,
      input,
      commitOnBlur: true
    };

    page.shell.append(input);
    requestAnimationFrame(() => input.focus());

    input.addEventListener('keydown', (keyEvent) => {
      keyEvent.stopPropagation();

      if (keyEvent.key === 'Enter') {
        keyEvent.preventDefault();
        this.commitTextEditor();
      }

      if (keyEvent.key === 'Escape') {
        this.discardTextEditor();
      }
    });

    input.addEventListener('blur', () => {
      if (this.activeEditor?.commitOnBlur) {
        this.commitTextEditor();
      }
    });
  }

  commitTextEditor() {
    const editor = this.activeEditor;
    if (!editor) {
      return;
    }

    const content = editor.input.value.trim();
    if (content) {
      const annotation = createAnnotation(
        createTextAnnotation(editor.point, content, this.currentColor)
      );
      annotation.pageNumber = editor.page.meta.pageNumber;
      this.addAnnotation(editor.page, annotation);
    }

    this.removeEditor(editor);
  }

  discardTextEditor() {
    if (this.activeEditor) {
      this.activeEditor.commitOnBlur = false;
      this.removeEditor(this.activeEditor);
    }
  }

  removeEditor(editor) {
    editor.input.remove();
    if (this.activeEditor === editor) {
      this.activeEditor = null;
    }
  }

  selectTool(tool, selectedButton) {
    this.currentTool = tool;
    this.elements.toolButtons.forEach((button) => {
      button.classList.toggle('active', button === selectedButton);
    });

    for (const page of this.pages.values()) {
      page.annotationCanvas.classList.toggle('tool-eraser', tool === 'eraser');
    }
  }

  async saveAnnotations() {
    try {
      if (!this.database.enabled) {
        await this.saveAnnotationsToMemory();
        return;
      }

      await this.database.saveFile({
        id: this.documentId,
        name: this.fileName,
        size: this.sourceBytes?.length ?? 0,
        updatedAt: Date.now()
      });
      await this.database.saveAnnotations(this.documentId, this.annotationsByPage);
    } catch (error) {
      await this.saveAnnotationsToMemory();
      this.setStatus(`IndexedDB 不可用，标注仅保留在当前页面：${error.message}`);
    }
  }

  async saveAnnotationsToMemory() {
    this.database.enabled = false;
    await this.database.saveFile({
      id: this.documentId,
      name: this.fileName,
      size: this.sourceBytes?.length ?? 0,
      updatedAt: Date.now()
    });
    await this.database.saveAnnotations(this.documentId, this.annotationsByPage);
  }

  async exportPdf() {
    if (!this.sourceBytes) {
      return;
    }

    this.commitTextEditor();
    this.elements.exportButton.disabled = true;
    this.setStatus('正在导出带标注的 PDF…');

    try {
      const textImages = new Map();

      for (const page of this.pages.values()) {
        const annotations = this.annotationsByPage[String(page.meta.pageNumber)] ?? [];
        const image = await rasterizePageText(
          annotations,
          page.meta.width,
          page.meta.height,
          {
            width: page.meta.rawWidth,
            height: page.meta.rawHeight,
            rotation: page.meta.rotation
          }
        );

        if (image) {
          textImages.set(page.meta.pageNumber, image);
        }
      }

      const bytes = await exportAnnotatedPdf(
        this.sourceBytes,
        Object.entries(this.annotationsByPage).map(([pageNumber, annotations]) => [
          Number(pageNumber),
          annotations
        ]),
        textImages,
        new Map(this.pageMetas.map((meta) => [meta.pageNumber, meta]))
      );

      this.downloadBytes(bytes, this.createExportName());
      this.setStatus('导出完成');
    } catch (error) {
      this.showError(`导出失败：${error.message}`);
    } finally {
      this.elements.exportButton.disabled = false;
    }
  }

  downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  createExportName() {
    return this.fileName.replace(/\.pdf$/i, '') + '-annotated.pdf';
  }

  updatePageIndicator() {
    this.elements.pageIndicator.textContent = this.pageMetas.length
      ? `共 ${this.pageMetas.length} 页`
      : '';
  }

  setStatus(message) {
    this.elements.statusText.textContent = message;
  }

  showError(message) {
    if (!this.pageMetas.length) {
      this.elements.viewerElement.classList.add('hidden');
      this.elements.emptyStateElement.classList.remove('hidden');
      this.elements.exportButton.disabled = true;
    }

    this.setStatus(message);
    window.alert(message);
  }
}

function isCancelledOrPasswordError(error) {
  return (
    error.name === 'RenderingCancelledException' ||
    error.name === 'PasswordException' ||
    /password|密码/i.test(error.message ?? '')
  );
}
