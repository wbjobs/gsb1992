import { estimateTextWidth } from './annotations';

export function rasterizePageText(annotations, displayWidth, displayHeight, rawSize) {
  if (!annotations.length) {
    return Promise.resolve(null);
  }

  const scale = Math.min(2, 2048 / Math.max(displayWidth, displayHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(displayWidth * scale);
  canvas.height = Math.ceil(displayHeight * scale);

  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const rawWidth = rawSize?.width ?? displayWidth;
  const rawHeight = rawSize?.height ?? displayHeight;
  const rotation = ((Math.round((rawSize?.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;

  if (rotation === 0) {
    ctx.transform(1, 0, 0, -1, 0, rawHeight);
  }

  if (rotation === 90) {
    ctx.transform(0, 1, -1, 0, 0, rawWidth);
  }

  if (rotation === 180) {
    ctx.transform(-1, 0, 0, -1, rawWidth, rawHeight);
  }

  if (rotation === 270) {
    ctx.transform(0, -1, 1, 0, rawHeight, 0);
  }

  for (const annotation of annotations) {
    if (annotation.type !== 'text' || !annotation.content) {
      continue;
    }

    ctx.save();
    ctx.fillStyle = annotation.color;
    ctx.font = `${annotation.size}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(annotation.content, annotation.x, annotation.y);
    ctx.restore();
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('文字标注栅格化失败'));
        return;
      }

      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}

export function createTextAnnotation(point, content, color) {
  const size = 14;

  return {
    type: 'text',
    x: point[0],
    y: point[1],
    content,
    color,
    size,
    width: estimateTextWidth(content, size)
  };
}
