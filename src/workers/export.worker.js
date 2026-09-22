import { exportAnnotatedPdf } from '../lib/exporter';

self.onmessage = async (event) => {
  const { requestId, sourceBytes, annotationsByPage, textImagesByAnnotation } = event.data;

  try {
    const bytes = await exportAnnotatedPdf(
      sourceBytes,
      annotationsByPage,
      new Map(textImagesByAnnotation)
    );

    self.postMessage({ type: 'exported', requestId, bytes }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({
      type: 'export-error',
      requestId,
      name: error?.name ?? 'Error',
      message: error?.message ?? 'PDF 导出失败'
    });
  }
};
