import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTextAnnotation, rasterizeTextAnnotation } from './text-raster';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('text raster', () => {
  it('creates text annotation in pdf user coordinates', () => {
    const annotation = createTextAnnotation([30, 700], '中文', '#123456');
    expect(annotation).toMatchObject({
      type: 'text',
      x: 30,
      y: 700,
      content: '中文',
      color: '#123456',
      size: 14
    });
    expect(annotation.width).toBeGreaterThan(14);
  });

  it('rasterizes text to transparent png metadata', async () => {
    const fillText = vi.fn();
    const toBlob = vi.fn((callback) => callback(new Blob(['png'], { type: 'image/png' })));
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        font: '',
        measureText: () => ({ width: 80 }),
        scale: vi.fn(),
        fillStyle: '',
        textAlign: '',
        textBaseline: '',
        fillText
      }),
      toBlob
    };

    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    vi.stubGlobal(
      'Blob',
      class {
        constructor(parts, options) {
          this.parts = parts;
          this.options = options;
        }

        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer;
        }
      }
    );

    const record = await rasterizeTextAnnotation({
      id: 'text-1',
      content: 'Hello',
      color: '#ff0000',
      size: 14
    });

    expect(fillText).toHaveBeenCalledWith('Hello', 0, 12.6);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect(record).toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      ascent: 12.6,
      descent: 3.5
    });
  });
});
