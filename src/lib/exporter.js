import { PDFDocument, degrees, rgb } from 'pdf-lib';

export async function exportAnnotatedPdf(
  sourceBytes,
  annotationsByPage,
  textImagesByPage = new Map(),
  pageMetasByPage = new Map()
) {
  const document = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });

  for (const [pageNumber, annotations] of annotationsByPage) {
    const pageIndex = pageNumber - 1;
    const page = document.getPages()[pageIndex];

    if (!page) {
      continue;
    }

    for (const annotation of annotations) {
      if (annotation.type === 'pen') {
        drawPenInPdf(page, annotation, pageMetasByPage.get(pageNumber));
      }

      if (annotation.type === 'highlight') {
        drawHighlightInPdf(page, annotation, pageMetasByPage.get(pageNumber));
      }
    }

    const textImageBytes = textImagesByPage.get(pageNumber);
    if (textImageBytes) {
      const image = await document.embedPng(textImageBytes);
      drawFullPageImage(page, image, pageMetasByPage.get(pageNumber));
    } else {
      for (const annotation of annotations) {
        if (annotation.type === 'text') {
          await drawTextInPdf(page, document, annotation);
        }
      }
    }
  }

  return document.save();
}

function drawPenInPdf(page, annotation, meta) {
  if (annotation.points.length < 2) {
    return;
  }

  const color = hexToRgb(annotation.color);

  for (let index = 0; index < annotation.points.length - 1; index += 1) {
    const [startX, startY] = rotatedPointToPdfPoint(annotation.points[index], meta);
    const [endX, endY] = rotatedPointToPdfPoint(annotation.points[index + 1], meta);

    page.drawLine({
      start: { x: startX, y: startY },
      end: { x: endX, y: endY },
      thickness: annotation.lineWidth,
      color
    });
  }
}

function drawHighlightInPdf(page, annotation, meta) {
  const rect = rotatedRectToPdfRect(annotation.rect, meta);

  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: hexToRgb(annotation.color),
    opacity: 0.28,
    borderWidth: 0
  });
}

function drawFullPageImage(page, image, meta) {
  const rotation = normalizeRotation(meta?.rotation);

  if (!rotation) {
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: page.getWidth(),
      height: page.getHeight()
    });
    return;
  }

  const width = meta?.rawWidth ?? page.getWidth();
  const height = meta?.rawHeight ?? page.getHeight();

  if (rotation === 180) {
    page.drawImage(image, {
      x: width,
      y: height,
      width,
      height,
      rotate: degrees(180)
    });
    return;
  }

  if (rotation === 90) {
    page.drawImage(image, {
      x: width,
      y: 0,
      width: height,
      height: width,
      rotate: degrees(90)
    });
    return;
  }

  page.drawImage(image, {
    x: 0,
    y: height,
    width: height,
    height: width,
    rotate: degrees(270)
  });
}

export function rotatedPointToPdfPoint(point, meta) {
  const rotation = normalizeRotation(meta?.rotation);
  const width = meta?.rawWidth ?? 0;
  const height = meta?.rawHeight ?? 0;
  const [x, y] = point;

  if (rotation === 90) {
    return [y, x];
  }

  if (rotation === 180) {
    return [width - x, height - y];
  }

  if (rotation === 270) {
    return [height - x, width - y];
  }

  return [x, y];
}

export function rotatedRectToPdfRect(rect, meta) {
  const rotation = normalizeRotation(meta?.rotation);

  if (!rotation) {
    return rect;
  }

  const points = [
    rotatedPointToPdfPoint([rect.x, rect.y], meta),
    rotatedPointToPdfPoint([rect.x + rect.width, rect.y], meta),
    rotatedPointToPdfPoint([rect.x, rect.y + rect.height], meta),
    rotatedPointToPdfPoint([rect.x + rect.width, rect.y + rect.height], meta)
  ];

  const x = Math.min(...points.map(([pointX]) => pointX));
  const y = Math.min(...points.map(([, pointY]) => pointY));
  const maxX = Math.max(...points.map(([pointX]) => pointX));
  const maxY = Math.max(...points.map(([, pointY]) => pointY));

  return { x, y, width: maxX - x, height: maxY - y };
}

function normalizeRotation(rotation) {
  return ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
}


async function drawTextInPdf(page, document, annotation) {
  const content = sanitizePdfText(annotation.content);

  if (!content) {
    return;
  }

  const font = await document.embedFont('Helvetica');
  page.drawText(content, {
    x: annotation.x,
    y: annotation.y,
    size: annotation.size,
    font,
    color: hexToRgb(annotation.color)
  });
}

export function sanitizePdfText(content) {
  return Array.from(content)
    .filter((char) => char.codePointAt(0) >= 32 || char === '\t' || char === '\n')
    .join('')
    .trim();
}

export function hexToRgb(hex) {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized, 16);

  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}
