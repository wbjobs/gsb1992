import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  exportAnnotatedPdf,
  rotatedPointToPdfPoint,
  rotatedRectToPdfRect,
  sanitizePdfText
} from './exporter';

async function createOnePagePdf() {
  const document = await PDFDocument.create();
  document.addPage([595, 842]);
  return document.save();
}

describe('pdf exporter', () => {
  it('exports annotations into a valid pdf', async () => {
    const source = await createOnePagePdf();
    const output = await exportAnnotatedPdf(
      source,
      new Map([
        [
          1,
          [
            {
              id: 'pen-1',
              type: 'pen',
              color: '#ff0000',
              lineWidth: 2,
              points: [[50, 800], [120, 780]]
            },
            {
              id: 'highlight-1',
              type: 'highlight',
              color: '#ffff00',
              rect: { x: 40, y: 700, width: 100, height: 24 }
            }
          ]
        ]
      ])
    );

    const exported = await PDFDocument.load(output);
    expect(exported.getPages()).toHaveLength(1);
    expect(output).not.toEqual(source);
  });

  it('sanitizes control characters', () => {
    expect(sanitizePdfText('ok\u0001')).toBe('ok');
  });

  it('maps rotated viewport points to unrotated pdf coordinates', () => {
    const meta = { rotation: 90, rawWidth: 595, rawHeight: 842 };

    expect(rotatedPointToPdfPoint([0, 0], meta)).toEqual([0, 0]);
    expect(rotatedPointToPdfPoint([842, 595], meta)).toEqual([595, 842]);

    meta.rotation = 180;
    expect(rotatedPointToPdfPoint([10, 20], meta)).toEqual([585, 822]);

    meta.rotation = 270;
    expect(rotatedPointToPdfPoint([842, 595], meta)).toEqual([0, 0]);
    expect(rotatedPointToPdfPoint([0, 0], meta)).toEqual([842, 595]);
  });

  it('maps rotated highlight bounds', () => {
    expect(
      rotatedRectToPdfRect(
        { x: 10, y: 20, width: 30, height: 40 },
        { rotation: 180, rawWidth: 595, rawHeight: 842 }
      )
    ).toEqual({ x: 555, y: 782, width: 30, height: 40 });
  });
});
