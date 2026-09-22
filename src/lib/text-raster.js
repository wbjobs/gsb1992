import { estimateTextWidth } from './annotations';

const TEXT_RASTER_SCALE = 3;
const TEXT_ASCENT_RATIO = 0.9;
const TEXT_DESCENT_RATIO = 0.25;

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

export function rasterizeTextAnnotation(annotation) {
  if (!annotation.content || typeof document === 'undefined') {
    return Promise.resolve(null);
  }

  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  const font = `${annotation.size}px sans-serif`;
  measureContext.font = font;
  const measuredWidth = Math.max(
    estimateTextWidth(annotation.content, annotation.size),
    measureContext.measureText(annotation.content).width
  );
  const ascent = annotation.size * TEXT_ASCENT_RATIO;
  const descent = annotation.size * TEXT_DESCENT_RATIO;
  const cssWidth = Math.ceil(measuredWidth + 2);
  const cssHeight = Math.ceil(ascent + descent);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(cssWidth * TEXT_RASTER_SCALE);
  canvas.height = Math.ceil(cssHeight * TEXT_RASTER_SCALE);

  const context = canvas.getContext('2d');
  context.scale(TEXT_RASTER_SCALE, TEXT_RASTER_SCALE);
  context.fillStyle = annotation.color;
  context.font = font;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillText(annotation.content, 0, ascent);

  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('文字标注栅格化失败'));
        return;
      }

      resolve({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        width: cssWidth,
        ascent,
        descent
      });
    }, 'image/png');
  });
}

export async function rasterizeTextAnnotations(annotations) {
  const records = new Map();

  await Promise.all(
    annotations
      .filter((annotation) => annotation.type === 'text' && annotation.content)
      .map(async (annotation) => {
        const record = await rasterizeTextAnnotation(annotation);
        if (record) {
          records.set(annotation.id, record);
        }
      })
  );

  return records;
}
