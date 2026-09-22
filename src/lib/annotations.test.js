import { describe, expect, it } from 'vitest';
import {
  createAnnotation,
  estimateTextWidth,
  findAnnotationAt
} from './annotations';

describe('annotations', () => {
  it('creates stable annotation records', () => {
    const annotation = createAnnotation({
      type: 'pen',
      pageNumber: 2,
      points: [[0, 0], [1, 1]]
    });

    expect(annotation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(annotation.color).toBe('#ff2d2d');
    expect(annotation.pageNumber).toBe(2);
  });

  it('finds pen strokes by segment distance', () => {
    const annotation = createAnnotation({
      type: 'pen',
      points: [[0, 0], [10, 0]]
    });

    expect(findAnnotationAt([annotation], [5, 0.4], 0.5)).toBe(annotation);
    expect(findAnnotationAt([annotation], [5, 2], 0.5)).toBeNull();
  });

  it('finds highlight rectangles and text bounds', () => {
    const highlight = createAnnotation({
      type: 'highlight',
      rect: { x: 5, y: 5, width: 20, height: 10 }
    });
    const text = createAnnotation({
      type: 'text',
      x: 5,
      y: 20,
      size: 10,
      content: 'abc'
    });

    expect(findAnnotationAt([highlight], [10, 8], 1)).toBe(highlight);
    expect(findAnnotationAt([text], [6, 23], 1)).toBe(text);
  });

  it('estimates cjk text wider than latin text', () => {
    expect(estimateTextWidth('中', 10)).toBe(10);
    expect(estimateTextWidth('a', 10)).toBe(5.6000000000000005);
  });
});
