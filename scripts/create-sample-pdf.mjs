import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

const document = await PDFDocument.create();
const font = await document.embedFont(StandardFonts.HelveticaBold);

for (const pageNumber of [1, 2, 3]) {
  const page = document.addPage([595, 842]);
  page.drawText(`PDF Canvas Test ${pageNumber}`, {
    x: 64,
    y: 770,
    size: 24,
    font,
    color: rgb(0.08, 0.18, 0.35)
  });
  page.drawText('Pen, highlight, text annotations and export acceptance sample.', {
    x: 64,
    y: 730,
    size: 12,
    color: rgb(0.25, 0.3, 0.4)
  });

  for (let index = 0; index < 12; index += 1) {
    page.drawLine({
      start: { x: 64, y: 690 - index * 42 },
      end: { x: 530, y: 690 - index * 42 },
      thickness: 0.7,
      color: rgb(0.82, 0.85, 0.9)
    });
  }
}

await mkdir('public', { recursive: true });
await writeFile('public/sample.pdf', await document.save());
