import { distancePointToSegment } from './geometry';

export function createAnnotation(partial) {
  const now = Date.now();

  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    color: '#ff2d2d',
    lineWidth: 2,
    ...partial
  };
}

export function drawAnnotation(ctx, annotation, transform, dpr) {
  const [a, b, c, d, e, f] = transform;
  ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f);

  if (annotation.type === 'pen') {
    drawPen(ctx, annotation);
  }

  if (annotation.type === 'highlight') {
    drawHighlight(ctx, annotation);
  }

  if (annotation.type === 'text') {
    drawText(ctx, annotation);
  }
}

function drawPen(ctx, annotation) {
  if (annotation.points.length < 2) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = annotation.color;
  ctx.lineWidth = annotation.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(annotation.points[0][0], annotation.points[0][1]);

  for (const [x, y] of annotation.points.slice(1)) {
    ctx.lineTo(x, y);
  }

  ctx.stroke();
  ctx.restore();
}

function drawHighlight(ctx, annotation) {
  const { x, y, width, height } = annotation.rect;

  ctx.save();
  ctx.fillStyle = annotation.color;
  ctx.globalAlpha = 0.28;
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}

function drawText(ctx, annotation) {
  if (!annotation.content) {
    return;
  }

  ctx.save();
  ctx.fillStyle = annotation.color;
  ctx.font = `${annotation.size}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(annotation.content, annotation.x, annotation.y);
  ctx.restore();
}

export function redrawAnnotationLayer(canvas, annotations, baseTransform, scale, dpr) {
  const ctx = canvas.getContext('2d');
  const transform = baseTransform.map((value) => value * scale);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const annotation of annotations) {
    drawAnnotation(ctx, annotation, transform, dpr);
  }
}

export function findAnnotationAt(annotations, pdfPoint, viewportThreshold) {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];

    if (annotation.type === 'pen' && hitsPen(annotation, pdfPoint, viewportThreshold)) {
      return annotation;
    }

    if (annotation.type === 'highlight' && hitsHighlight(annotation, pdfPoint)) {
      return annotation;
    }

    if (annotation.type === 'text' && hitsText(annotation, pdfPoint)) {
      return annotation;
    }
  }

  return null;
}

function hitsPen(annotation, point, threshold) {
  return annotation.points.some((segmentStart, index) => {
    const segmentEnd = annotation.points[index + 1];
    return segmentEnd && distancePointToSegment(point, segmentStart, segmentEnd) <= threshold;
  });
}

function hitsHighlight(annotation, point) {
  const { x, y, width, height } = annotation.rect;
  return point[0] >= x && point[0] <= x + width && point[1] >= y && point[1] <= y + height;
}

function hitsText(annotation, point) {
  const width = estimateTextWidth(annotation.content, annotation.size);
  return (
    point[0] >= annotation.x &&
    point[0] <= annotation.x + width &&
    point[1] >= annotation.y - annotation.size * 0.9 &&
    point[1] <= annotation.y + annotation.size * 0.25
  );
}

export function estimateTextWidth(content, size) {
  const units = Array.from(content).reduce((total, char) => {
    return total + (char.codePointAt(0) > 255 ? 1 : 0.56);
  }, 0);

  return units * size;
}
