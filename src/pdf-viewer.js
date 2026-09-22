import {
  createAnnotation,
  drawAnnotation,
  findAnnotationAt,
  redrawAnnotationLayer
} from './lib/annotations';
import { normalizePdfRect, viewportPointToPdfPoint } from './lib/geometry';
import { PdfDatabase, debounce } from './lib/pdf-database';
import { exportAnnotatedPdf } from './lib/exporter';
import { createTextAnnotation, rasterizeTextAnnotations } from './lib/text-raster';

export class PdfViewer {
  constructor(elements) {
    this.elements = elements;
    this.database = new PdfDatabase();
    this.worker = null;
    this.exportWorker = null;
    this.requestId = 0;
    this.loadToken = 0;
    this.loadResolver = null;
    this.loadRejecter = null;
    this.loadSettled = false;
    this.loadRequestId = 0;
    this.fileName = '';
    this.documentId = '';
    this.sourceBytes = null;
    this.isEncrypted = false;
    this.pageMetas = [];
    this.annotationsByPage = {};
    this.pages = new Map();
    this.scale = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.currentTool = 'pen';
    this.currentColor = elements.colorPicker?.value ?? '#ff2d2d';
    this.activeStroke = null;
    this.activeEditor = null;
    this.observer = null;
    this.storageHealthy = true;
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
      clearButton,
      toolButtons
    } = this.elements;

    fileInput.addEventListener('change', (event) => this.handleFileSelection(event));
    emptyFileInput.addEventListener('change', (event) => this.handleFileSelection(event));
    exportButton.addEventListener('click', () => this.exportPdf());
    zoomInButton.addEventListener('click', () => this.setScale(this.scale + 0.15));
    zoomOutButton.addEventListener('click', () => this.setScale(this.scale - 0.15));
    fitWidthButton.addEventListener('click', () => this.fitWidth());
    clearButton?.addEventListener('click', () => this.clearCurrentDocument());
    colorPicker.addEventListener('change', () => {
      this.currentColor = colorPicker.value;
    });

    toolButtons.forEach((button) => {
      button.addEventListener('click', () => this.selectTool(button.dataset.tool, button));
    });

    window.addEventListener('resize', debounce(() => {
      if (this.pageMetas.length) {
        this.renderVisiblePages();
      }
    }, 150));

    this.setStatus('就绪');
    this.loadRecentDocuments();
  }

  async loadRecentDocuments() {
    try {
      const records = await this.database.listRecentFiles();
      this.renderRecentDocuments(records.filter((record) => record.hasBytes));
    } catch {
      this.renderRecentDocuments([]);
    }
  }

  renderRecentDocuments(records) {
    const container = this.elements.recentList;
    if (!container) {
      return;
    }

    container.replaceChildren();
    if (!records.length) {
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = '继续标注';
    const list = document.createElement('div');
    list.className = 'recent-list';

    records.slice(0, 5).forEach((record) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button recent-item';
      button.textContent = record.name;
      button.title = `恢复 ${record.name}`;
      button.addEventListener('click', () => this.restoreDocument(record.id));
      list.append(button);
    });

    container.append(heading, list);
  }

  async restoreDocument(documentId) {
    try {
      const record = await this.database.getFile(documentId);
      if (!record?.bytes) {
        throw new Error('本地 PDF 数据已不可用');
      }

      const file = new File([record.bytes], record.name, {
        type: 'application/pdf',
        lastModified: record.updatedAt ?? Date.now()
      });
      await this.loadDocument(file);
    } catch (error) {
      this.showError(error.message || '恢复文档失败');
    }
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

    if (typeof Worker === 'undefined' || !HTMLCanvasElement.prototype.transferControlToOffscreen) {
      throw new Error('当前浏览器不支持 Web Worker 或 OffscreenCanvas');
    }

    const token = ++this.loadToken;
    this.terminateWorker();
    this.resetDocumentState();
    this.elements.exportButton.disabled = true;

    const bytes = new Uint8Array(await file.arrayBuffer());
    this.sourceBytes = bytes;
    this.fileName = file.name;
    this.documentId = await this.createDocumentId(bytes);
    this.storageHealthy = true;

    try {
      this.annotationsByPage = await this.database.getAnnotations(this.documentId);
    } catch {
      this.annotationsByPage = {};
    }

    this.createRenderWorker(token);
    const transferBytes = bytes.slice();
    this.loadSettled = false;
    const loadPromise = new Promise((resolve, reject) => {
      this.loadResolver = resolve;
      this.loadRejecter = reject;
    });

    this.loadRequestId = this.postWorkerMessage('load', { bytes: transferBytes.buffer }, [
      transferBytes.buffer
    ]);
    await loadPromise;
  }

  createRenderWorker(token) {
    this.worker = new Worker(new URL('./workers/pdf.worker.js', import.meta.url), {
      type: 'module'
    });

    this.worker.onmessage = (event) => {
      if (token === this.loadToken) {
        this.handleWorkerMessage(event.data);
      }
    };

    this.worker.onerror = (event) => {
      if (token !== this.loadToken) {
        return;
      }
      if (this.loadResolver) {
        this.failLoad(new Error(event.message || 'PDF Worker 发生错误'));
      } else {
        this.showError(event.message || 'PDF Worker 发生错误');
      }
    };
  }

  handleWorkerMessage(message) {
    if (message.type === 'password-required') {
      this.promptPassword(message);
      return;
    }

    if (message.type === 'loaded') {
      this.pageMetas = message.pages;
      this.isEncrypted = Boolean(message.isEncrypted);
      this.preparePages();
      this.elements.emptyStateElement.classList.add('hidden');
      this.elements.viewerElement.classList.remove('hidden');
      this.elements.clearButton?.classList.remove('hidden');
      this.setStatus(`已加载 ${this.pageMetas.length} 页`);
      this.updateZoomLabel();
      this.fitWidth();
      for (const page of this.pages.values()) {
        this.observer.observe(page.shell);
      }
      this.elements.exportButton.disabled = false;
      this.persistLoadedDocument();
      this.resolveLoad();
      return;
    }

    if (message.type === 'rendered') {
      this.markPageRendered(message.pageNumber);
      return;
    }

    if (message.type === 'decrypted-bytes' && this.pendingDecryptedResolver) {
      this.pendingDecryptedResolver(message.bytes);
      this.pendingDecryptedResolver = null;
    this.pendingDecryptedRejecter = null;
    this.pendingDecryptedRequestId = 0;
      return;
    }

    if (message.type === 'error' && !isCancelledError(message)) {
      if (!this.loadSettled && this.loadResolver && message.requestId === this.loadRequestId) {
        this.failLoad(new Error(message.message));
        return;
      }

      if (message.pageNumber) {
        const page = this.pages.get(message.pageNumber);
        if (page?.loading) {
          page.loading.hidden = true;
        }
      }
      this.showError(message.message);
    }
  }

  promptPassword(message) {
    if (message.requestId !== this.loadRequestId) {
      return;
    }

    const label = message.reason === 2 ? '密码不正确，请重新输入 PDF 密码' : 'PDF 已加密，请输入打开密码';
    const password = window.prompt(label);
    if (password === null) {
      this.postWorkerMessage('password', {
        requestId: message.passwordRequestId,
        passwordRequestId: message.passwordRequestId,
        password: ''
      });
      this.failLoad(new Error('已取消输入 PDF 密码'));
      return;
    }

    this.postWorkerMessage('password', {
      requestId: message.passwordRequestId,
      passwordRequestId: message.passwordRequestId,
      password
    });
  }

  resolveLoad() {
    const resolve = this.loadResolver;
    this.loadResolver = null;
    this.loadRejecter = null;
    this.loadSettled = true;
    resolve?.();
  }

  failLoad(error) {
    if (this.loadSettled) {
      if (!this.pageMetas.length) {
        this.setStatus(error.message);
      } else {
        this.showError(error.message);
      }
      return;
    }

    const reject = this.loadRejecter;
    this.loadResolver = null;
    this.loadRejecter = null;
    this.loadSettled = true;
    reject?.(error);
    if (!reject) {
      this.showError(error.message);
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
    this.isEncrypted = false;
  }

  terminateWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  async createDocumentId(bytes) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes.slice(0, 1024 * 1024));
      const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 32);
      return `pdf-${hash}-${bytes.length}`;
    } catch {
      let hash = 5381;
      for (const value of bytes.slice(0, 1024)) {
        hash = (hash * 33) ^ value;
      }
      return `pdf-${(hash >>> 0).toString(16)}-${bytes.length}`;
    }
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

    for (const canvas of [page.baseCanvas, page.annotationCanvas, page.draftCanvas]) {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

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
    if (!page.active) {
      page.active = true;
      this.applyPageSize(page);
    }
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
    if (page.renderedScale !== this.scale) {
      page.loading.hidden = true;
      this.postWorkerMessage('cancel-render', { pageNumber: page.meta.pageNumber });
    }
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
    canvas.addEventListener('pointermove', (event) => this.handlePointerMove(page, event));
    canvas.addEventListener('pointerup', () => this.handlePointerUp(page));
    canvas.addEventListener('pointercancel', () => this.cancelDraft(page));
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
    const { annotation } = this.activeStroke;

    if (annotation.type === 'pen') {
      const previous = annotation.points.at(-1);
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 0.35 / this.scale) {
        return;
      }
      annotation.points.push(point);
      this.drawDraft(page, annotation);
      return;
    }

    if (annotation.type === 'highlight') {
      annotation.rect = normalizePdfRect(this.activeStroke.start, point);
      this.drawDraft(page, annotation);
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

    if (annotation.type === 'highlight' && annotation.rect.width >= 2 && annotation.rect.height >= 2) {
      this.addAnnotation(page, annotation);
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
    redrawAnnotationLayer(
      page.annotationCanvas,
      this.annotationsByPage[String(page.meta.pageNumber)] ?? [],
      page.meta.baseTransform,
      this.scale,
      this.dpr
    );
  }

  drawDraft(page, annotation) {
    const context = page.draftContext;
    const transform = page.meta.baseTransform.map((value) => value * this.scale);
    const [a, b, c, d, e, f] = transform;

    if (annotation.type === 'pen') {
      if (annotation.points.length === 1) {
        return;
      }

      context.setTransform(this.dpr * a, this.dpr * b, this.dpr * c, this.dpr * d, this.dpr * e, this.dpr * f);
      context.strokeStyle = annotation.color;
      context.lineWidth = annotation.lineWidth;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      const start = annotation.points.length === 2 ? annotation.points[0] : annotation.points.at(-2);
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

    this.activeEditor = { page, point, input, commitOnBlur: true };
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

  async persistLoadedDocument() {
    const record = {
      id: this.documentId,
      name: this.fileName,
      size: this.sourceBytes?.length ?? 0,
      updatedAt: Date.now(),
      isEncrypted: this.isEncrypted,
      annotationsCount: this.countAnnotations()
    };

    try {
      await this.database.saveDocumentBytes({
        ...record,
        bytes: this.sourceBytes.slice()
      });
    } catch (error) {
      this.storageHealthy = false;
      this.setStatus(`PDF 过大，无法完整保存到 IndexedDB：${error.message}`);
      try {
        await this.database.saveDocumentMeta(record);
      } catch {
        // Metadata is best-effort when storage quota is exhausted.
      }
    }
  }

  async saveAnnotations() {
    const updatedAt = Date.now();
    try {
      await this.database.saveAnnotations(this.documentId, this.annotationsByPage, updatedAt);
      await this.database.saveDocumentMeta({
        id: this.documentId,
        name: this.fileName,
        size: this.sourceBytes?.length ?? 0,
        isEncrypted: this.isEncrypted,
        annotationsCount: this.countAnnotations(),
        updatedAt
      });
    } catch (error) {
      this.storageHealthy = false;
      this.setStatus(`IndexedDB 不可用，标注仅保留在当前页面：${error.message}`);
    }
  }

  countAnnotations() {
    return Object.values(this.annotationsByPage).reduce((total, list) => total + list.length, 0);
  }

  async clearCurrentDocument() {
    if (!this.documentId) {
      return;
    }

    const shouldClear = window.confirm('从本地缓存中删除当前 PDF 和标注？');
    if (!shouldClear) {
      return;
    }

    const documentId = this.documentId;
    this.terminateWorker();
    this.resetDocumentState();
    this.sourceBytes = null;
    this.documentId = '';
    this.fileName = '';
    this.elements.exportButton.disabled = true;
    this.elements.clearButton?.classList.add('hidden');
    this.elements.viewerElement.classList.add('hidden');
    this.elements.emptyStateElement.classList.remove('hidden');
    await this.database.clearDocument(documentId);
    await this.loadRecentDocuments();
    this.setStatus('已清除本地文档');
  }

  async exportPdf() {
    if (!this.sourceBytes) {
      return;
    }

    this.commitTextEditor();
    this.elements.exportButton.disabled = true;
    this.setStatus('正在导出带标注的 PDF…');

    try {
      const annotationsByPage = Object.entries(this.annotationsByPage).map(
        ([pageNumber, annotations]) => [Number(pageNumber), annotations]
      );
      const allAnnotations = annotationsByPage.flatMap(([, annotations]) => annotations);
      const textImages = await rasterizeTextAnnotations(allAnnotations);
      const sourceBytes = this.isEncrypted ? await this.getDecryptedBytes() : this.sourceBytes;
      const bytes = await this.runExport(sourceBytes, annotationsByPage, textImages);

      this.downloadBytes(bytes, this.createExportName());
      this.setStatus('导出完成');
    } catch (error) {
      this.showError(`导出失败：${error.message}`);
    } finally {
      this.elements.exportButton.disabled = false;
    }
  }

  getDecryptedBytes() {
    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      this.pendingDecryptedRequestId = requestId;
      const timer = window.setTimeout(() => {
        this.pendingDecryptedResolver = null;
        this.pendingDecryptedRejecter = null;
        this.pendingDecryptedRequestId = 0;
        reject(new Error('获取解密 PDF 数据超时'));
      }, 30000);

      this.pendingDecryptedResolver = (bytes) => {
        window.clearTimeout(timer);
        this.pendingDecryptedRejecter = null;
        this.pendingDecryptedRequestId = 0;
        resolve(new Uint8Array(bytes));
      };
      this.pendingDecryptedRejecter = reject;
      this.worker.postMessage({ type: 'get-decrypted-bytes', requestId });
    });
  }

  async runExport(sourceBytes, annotationsByPage, textImages) {
    if (typeof Worker === 'undefined') {
      return exportAnnotatedPdf(sourceBytes, annotationsByPage, textImages);
    }

    if (!this.exportWorker) {
      this.exportWorker = new Worker(new URL('./workers/export.worker.js', import.meta.url), {
        type: 'module'
      });
    }

    const requestId = ++this.requestId;
    const sourceCopy = sourceBytes.slice();
    const serializedTextImages = new Map();
    for (const [id, record] of textImages.entries()) {
      const bytesCopy = record.bytes.slice();
      serializedTextImages.set(id, { ...record, bytes: bytesCopy });
    }

    return new Promise((resolve, reject) => {
      const worker = this.exportWorker;
      let settled = false;
      const cleanup = () => {
        settled = true;
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
      };

      const handleMessage = async (event) => {
        const message = event.data;
        if (message.requestId !== requestId || settled) {
          return;
        }

        if (message.type === 'exported') {
          cleanup();
          resolve(new Uint8Array(message.bytes));
          return;
        }

        cleanup();
        try {
          resolve(await exportAnnotatedPdf(sourceBytes, annotationsByPage, textImages));
        } catch (fallbackError) {
          reject(new Error(message.message || fallbackError.message));
        }
      };

      const handleError = (event) => {
        if (settled) {
          return;
        }
        cleanup();
        reject(new Error(event.message || '导出 Worker 发生错误'));
      };

      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);

      worker.postMessage(
        {
          type: 'export',
          requestId,
          sourceBytes: sourceCopy,
          annotationsByPage,
          textImagesByAnnotation: [...serializedTextImages.entries()]
        },
        [
          sourceCopy.buffer,
          ...[...serializedTextImages.values()].map((record) => record.bytes.buffer)
        ]
      );
    });
  }

  downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function isCancelledError(error) {
  return error.name === 'RenderingCancelledException';
}
