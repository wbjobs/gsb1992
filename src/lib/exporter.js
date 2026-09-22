import { PDFDocument, rgb } from 'pdf-lib';

export async function exportAnnotatedPdf(
  sourceBytes,
  annotationsByPage,
  textImagesByAnnotation = new Map()
) {
  const document = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
  const pages = document.getPages();

  for (const [pageNumber, annotations] of annotationsByPage) {
    const page = pages[pageNumber - 1];
    if (!page) {
      continue;
    }

    for (const annotation of annotations) {
      if (annotation.type === 'pen') {
        drawPenInPdf(page, annotation);
      }

      if (annotation.type === 'highlight') {
        drawHighlightInPdf(page, annotation);
      }

      if (annotation.type === 'text') {
        await drawTextInPdf(page, document, annotation, textImagesByAnnotation);
      }
    }
  }

  return document.save();
}

function drawPenInPdf(page, annotation) {
  if (annotation.points.length < 2) {
    return;
  }

  const color = hexToRgb(annotation.color);

  for (let index = 0; index < annotation.points.length - 1; index += 1) {
    const [startX, startY] = annotation.points[index];
    const [endX, endY] = annotation.points[index + 1];

    page.drawLine({
      start: { x: startX, y: startY },
      end: { x: endX, y: endY },
      thickness: annotation.lineWidth,
      color
    });
  }
}

function drawHighlightInPdf(page, annotation) {
  page.drawRectangle({
    x: annotation.rect.x,
    y: annotation.rect.y,
    width: annotation.rect.width,
    height: annotation.rect.height,
    color: hexToRgb(annotation.color),
    opacity: 0.28,
    borderWidth: 0
  });
}

async function drawTextInPdf(page, document, annotation, textImagesByAnnotation) {
  const content = sanitizePdfText(annotation.content);
  if (!content) {
    return;
  }

  const imageRecord = textImagesByAnnotation.get(annotation.id);

  if (imageRecord) {
    const image = await document.embedPng(imageRecord.bytes);
    page.drawImage(image, {
      x: annotation.x,
      y: annotation.y - imageRecord.descent,
      width: imageRecord.width,
      height: imageRecord.ascent + imageRecord.descent
    });
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
