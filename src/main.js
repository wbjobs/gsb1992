import './styles.css';
import { PdfViewer } from './pdf-viewer.js';

const viewer = new PdfViewer({
  viewerElement: document.querySelector('#viewer'),
  emptyStateElement: document.querySelector('#emptyState'),
  statusText: document.querySelector('#statusText'),
  pageIndicator: document.querySelector('#pageIndicator'),
  fileInput: document.querySelector('#fileInput'),
  emptyFileInput: document.querySelector('#emptyFileInput'),
  exportButton: document.querySelector('#exportPdf'),
  zoomInButton: document.querySelector('#zoomIn'),
  zoomOutButton: document.querySelector('#zoomOut'),
  fitWidthButton: document.querySelector('#fitWidth'),
  zoomLabel: document.querySelector('#zoomLabel'),
  colorPicker: document.querySelector('#colorPicker'),
  toolButtons: document.querySelectorAll('.tool')
});

viewer.init();
