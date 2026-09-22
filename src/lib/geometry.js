export function scaleAffineTransform(transform, scale) {
  return transform.map((value) => value * scale);
}

export function applyAffineTransform(transform, x, y) {
  const [a, b, c, d, e, f] = transform;
  return [a * x + c * y + e, b * x + d * y + f];
}

export function invertAffineTransform(transform) {
  const [a, b, c, d, e, f] = transform;
  const determinant = a * d - b * c;

  if (Math.abs(determinant) < 1e-10) {
    throw new Error('无法反转无效的 PDF 坐标变换矩阵');
  }

  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant
  ];
}

export function viewportPointToPdfPoint(point, baseTransform, scale) {
  const viewportTransform = scaleAffineTransform(baseTransform, scale);
  return applyAffineTransform(invertAffineTransform(viewportTransform), point[0], point[1]);
}

export function pdfPointToViewportPoint(point, baseTransform, scale) {
  return applyAffineTransform(scaleAffineTransform(baseTransform, scale), point[0], point[1]);
}

export function normalizePdfRect(start, end) {
  const x = Math.min(start[0], end[0]);
  const y = Math.min(start[1], end[1]);
  const width = Math.abs(end[0] - start[0]);
  const height = Math.abs(end[1] - start[1]);

  return { x, y, width, height };
}

export function distancePointToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }

  const t = clamp(
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared,
    0,
    1
  );
  const nearestX = start[0] + t * dx;
  const nearestY = start[1] + t * dy;

  return Math.hypot(point[0] - nearestX, point[1] - nearestY);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
