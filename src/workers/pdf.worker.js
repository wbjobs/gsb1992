import * as pdfjs from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

let pdfDocument = null;
let sourceBytes = null;
let isEncrypted = false;
const renderTasks = new Map();
const canvases = new Map();
const renderGenerations = new Map();
const pendingPasswords = new Map();
let loadTask = null;

self.onmessage = (event) => {
  dispatchMessage(event.data).catch((error) => {
    postError(event.data?.requestId ?? 0, event.data?.pageNumber ?? null, error);
  });
};

async function dispatchMessage(message) {
  if (message.type === 'load') {
    return handleLoad(message);
  }

  if (message.type === 'password') {
    return resolvePassword(message.requestId, message.password);
  }

  if (message.type === 'render') {
    return handleRender(message);
  }

  if (message.type === 'init-canvas') {
    canvases.set(message.pageNumber, message.canvas);
    return;
  }

  if (message.type === 'cancel-render') {
    cancelRender(message.pageNumber);
    return;
  }

  if (message.type === 'clear-page') {
    clearPage(message.pageNumber);
    return;
  }

  if (message.type === 'release-canvas') {
    releaseCanvas(message.pageNumber);
    return;
  }

  if (message.type === 'get-decrypted-bytes') {
    return handleDecryptedBytes(message);
  }

  if (message.type === 'dispose') {
    return disposeDocument();
  }
}

async function handleLoad(message) {
  await disposeDocument();
  sourceBytes = message.bytes;
  isEncrypted = false;

  loadTask = pdfjs.getDocument({
    data: message.bytes,
    password: createPasswordHandler(message.requestId),
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: false
  });

  pdfDocument = await loadTask.promise;

  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const rawDimensions = viewport.rawDims
      ? { width: viewport.rawDims.pageWidth, height: viewport.rawDims.pageHeight }
      : { width: viewport.width, height: viewport.height };

    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      baseTransform: viewport.transform,
      rotation: page.rotate ?? 0,
      rawWidth: rawDimensions.width,
      rawHeight: rawDimensions.height
    });
    page.cleanup();
  }

  self.postMessage({
    type: 'loaded',
    requestId: message.requestId,
    fingerprints: pdfDocument.fingerprints,
    pageCount: pdfDocument.numPages,
    isEncrypted,
    pages
  });
}

function createPasswordHandler(loadRequestId) {
  return (callback, reason) => {
    isEncrypted = true;
    const passwordRequestId = crypto.randomUUID();
    pendingPasswords.set(passwordRequestId, callback);

    self.postMessage({
      type: 'password-required',
      requestId: loadRequestId,
      passwordRequestId,
      reason
    });
  };
}

function resolvePassword(passwordRequestId, password) {
  const pending = pendingPasswords.get(passwordRequestId);
  if (pending) {
    pendingPasswords.delete(passwordRequestId);
    pending.callback(password);
  }
}

async function handleDecryptedBytes(message) {
  if (!pdfDocument) {
    throw new Error('尚未加载 PDF 文档');
  }

  if (!isEncrypted) {
    self.postMessage({
      type: 'decrypted-bytes',
      requestId: message.requestId,
      bytes: sourceBytes
    });
    return;
  }

  const bytes = await pdfDocument.saveDocument();
  self.postMessage({ type: 'decrypted-bytes', requestId: message.requestId, bytes }, [
    bytes.buffer
  ]);
}

async function handleRender(message) {
  if (!pdfDocument) {
    throw new Error('尚未加载 PDF 文档');
  }

  const { pageNumber, scale, dpr } = message;
  const canvas = canvases.get(pageNumber);
  if (!canvas) {
    throw new Error(`第 ${pageNumber} 页的渲染画布尚未初始化`);
  }

  cancelRender(pageNumber);
  const generation = (renderGenerations.get(pageNumber) ?? 0) + 1;
  renderGenerations.set(pageNumber, generation);

  const page = await pdfDocument.getPage(pageNumber);
  if (renderGenerations.get(pageNumber) !== generation) {
    return;
  }

  const viewport = page.getViewport({ scale: 1 });
  const cssWidth = Math.max(1, Math.ceil(viewport.width * scale));
  const cssHeight = Math.max(1, Math.ceil(viewport.height * scale));
  canvas.width = Math.max(1, Math.ceil(cssWidth * dpr));
  canvas.height = Math.max(1, Math.ceil(cssHeight * dpr));

  const renderTask = page.render({
    canvas,
    canvasContext: canvas.getContext('2d'),
    viewport,
    transform: [dpr * scale, 0, 0, dpr * scale, 0, 0]
  });

  renderTasks.set(pageNumber, renderTask);
  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException') {
      return;
    }
    throw error;
  }

  if (renderGenerations.get(pageNumber) !== generation) {
    return;
  }

  renderTasks.delete(pageNumber);
  page.cleanup();
  self.postMessage({
    type: 'rendered',
    requestId: message.requestId,
    pageNumber,
    width: cssWidth,
    height: cssHeight
  });
}

function cancelRender(pageNumber) {
  const renderTask = renderTasks.get(pageNumber);
  renderGenerations.set(pageNumber, (renderGenerations.get(pageNumber) ?? 0) + 1);
  if (renderTask) {
    renderTask.cancel();
    renderTasks.delete(pageNumber);
  }
}

function clearPage(pageNumber) {
  cancelRender(pageNumber);
}

function releaseCanvas(pageNumber) {
  cancelRender(pageNumber);
  const canvas = canvases.get(pageNumber);
  if (canvas) {
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function disposeDocument() {
  for (const renderTask of renderTasks.values()) {
    renderTask.cancel();
  }
  pendingPasswords.clear();
  loadTask = null;
  renderTasks.clear();
  canvases.clear();
  renderGenerations.clear();

  if (pdfDocument) {
    await pdfDocument.destroy();
    pdfDocument = null;
  }
  sourceBytes = null;
  isEncrypted = false;
}

function postError(requestId, pageNumber, error) {
  self.postMessage({
    type: 'error',
    requestId,
    pageNumber,
    name: error?.name ?? 'Error',
    message: error?.message ?? '未知 PDF 处理错误'
  });
}
