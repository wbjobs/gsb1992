import { describe, expect, it } from 'vitest';
import {
  applyAffineTransform,
  invertAffineTransform,
  normalizePdfRect,
  viewportPointToPdfPoint
} from './geometry';

describe('pdf geometry', () => {
  it('round trips points through pdf viewport transform', () => {
    const baseTransform = [1, 0, 0, -1, 0, 792];
    const scale = 1.5;
    const pdfPoint = [120, 80];

    const [viewportX, viewportY] = applyAffineTransform(
      baseTransform.map((value) => value * scale),
      pdfPoint[0],
      pdfPoint[1]
    );
    expect([viewportX, viewportY]).toEqual([180, 1068]);

    expect(
      viewportPointToPdfPoint([viewportX, viewportY], baseTransform, scale)
    ).toEqual([120, 80]);
  });

  it('inverts an affine matrix', () => {
    const transform = [2, 0, 0, -2, 10, 20];
    expect(invertAffineTransform(transform)).toEqual([0.5, 0, 0, -0.5, -5, 10]);
  });

  it('normalizes reversed rectangles', () => {
    expect(normalizePdfRect([90, 20], [40, 70])).toEqual({
      x: 40,
      y: 20,
      width: 50,
      height: 50
    });
  });
});
