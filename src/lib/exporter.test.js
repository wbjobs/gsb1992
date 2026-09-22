import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { exportAnnotatedPdf, hexToRgb, sanitizePdfText } from './exporter';

async function createOnePagePdf() {
  const document = await PDFDocument.create();
  document.addPage([595, 842]);
  return document.save();
}

describe('pdf exporter', () => {
  it('exports vector annotations into a valid pdf', async () => {
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

  it('exports text annotations without rotation conversion', async () => {
    const source = await createOnePagePdf();
    const output = await exportAnnotatedPdf(
      source,
      new Map([
        [
          1,
          [
            {
              id: 'text-1',
              type: 'text',
              content: 'Hello PDF',
              color: '#00aa00',
              size: 14,
              x: 60,
              y: 760
            }
          ]
        ]
      ])
    );

    const exported = await PDFDocument.load(output);
    expect(exported.getPages()).toHaveLength(1);
    expect(output.byteLength).toBeGreaterThan(source.byteLength);
  });

  it('skips missing pages and malformed annotation records safely', async () => {
    const source = await createOnePagePdf();
    const output = await exportAnnotatedPdf(
      source,
      new Map([
        [2, [{ id: 'missing-page', type: 'pen', points: [[0, 0], [1, 1]] }]],
        [1, [{ id: 'empty-pen', type: 'pen', points: [] }]]
      ])
    );

    await expect(PDFDocument.load(output)).resolves.toBeTruthy();
  });

  it('sanitizes control characters', () => {
    expect(sanitizePdfText('ok\u0001')).toBe('ok');
  });

  it('parses hex colors', () => {
    expect(hexToRgb('#ff0000')).toMatchObject({ red: 1, green: 0, blue: 0 });
  });
});
