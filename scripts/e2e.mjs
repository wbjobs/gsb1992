import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { preview } from 'vite';

const previewServer = await preview({
  preview: { host: '127.0.0.1', port: 0, strictPort: false }
});
const baseUrl = previewServer.resolvedUrls.local[0];
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });

  const started = performance.now();
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.setInputFiles('#emptyFileInput', 'public/sample.pdf');
  await page.waitForSelector('.page-canvas', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#statusText')?.textContent?.includes('已加载'), {
    timeout: 15000
  });
  await page.waitForTimeout(900);

  const hasRenderedPixels = await page.evaluate(() => {
    const canvas = document.querySelector('.page-canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return data.some((value, index) => index % 4 === 3 && value > 0);
  });
  if (!hasRenderedPixels) {
    throw new Error('PDF 首页未渲染出非空像素');
  }

  const canvasBox = await page.locator('.page-shell').first().boundingBox();
  if (!canvasBox) {
    throw new Error('未找到 PDF 页面区域');
  }

  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 180);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 210, { steps: 8 });
  await page.mouse.move(canvasBox.x + 240, canvasBox.y + 185, { steps: 8 });
  await page.mouse.up();

  await page.click('[data-tool="highlight"]');
  await page.mouse.move(canvasBox.x + 90, canvasBox.y + 280);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 360, canvasBox.y + 315, { steps: 8 });
  await page.mouse.up();

  await page.click('[data-tool="text"]');
  await page.mouse.click(canvasBox.x + 120, canvasBox.y + 370);
  await page.keyboard.type('验收文字');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  await page.click('#exportPdf');
  const download = await downloadPromise;
  const outputDirectory = await mkdtemp(join(tmpdir(), 'pdf-e2e-'));
  const outputPath = join(outputDirectory, 'exported.pdf');
  await download.saveAs(outputPath);
  const exported = await PDFDocument.load(await readFile(outputPath));
  if (exported.getPages().length !== 3) {
    throw new Error('导出 PDF 页数不正确');
  }
  await rm(outputDirectory, { recursive: true, force: true });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.recent-item', { timeout: 5000 });
  await page.click('.recent-item');
  await page.waitForFunction(() => document.querySelector('#statusText')?.textContent?.includes('已加载'), {
    timeout: 15000
  });
  await page.waitForTimeout(500);

  const restoredAnnotations = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf-canvas-annotator', 2);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('annotations', 'readonly');
      const getAll = transaction.objectStore('annotations').getAll();
      getAll.onsuccess = () => {
        resolve(getAll.result.reduce((total, record) => (
          total + Object.values(record.annotations).reduce((sum, list) => sum + list.length, 0)
        ), 0));
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  }));

  if (restoredAnnotations !== 3) {
    throw new Error(`IndexedDB 中应恢复 3 个标注，实际为 ${restoredAnnotations}`);
  }

  const elapsed = performance.now() - started;
  if (elapsed > 20000) {
    throw new Error(`端到端耗时 ${Math.round(elapsed)}ms，超过 20s 性能阈值`);
  }

  const browserErrors = errors.filter((message) => !/favicon|Failed to load resource/i.test(message));
  if (browserErrors.length) {
    throw new Error(`浏览器错误：\n${browserErrors.join('\n')}`);
  }

  console.log(`PASS: render, 3 annotations, export, persistence, ${Math.round(elapsed)}ms`);
} finally {
  await browser?.close();
  await previewServer.httpServer.close();
}
