const DATABASE_NAME = 'pdf-canvas-annotator';
const DATABASE_VERSION = 2;

export class PdfDatabase {
  constructor() {
    this.databasePromise = null;
    this.enabled = typeof indexedDB !== 'undefined';
    this.memoryFiles = new Map();
    this.memoryAnnotations = new Map();
  }

  async open() {
    if (!this.enabled) {
      return null;
    }

    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('files')) {
            database.createObjectStore('files', { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains('annotations')) {
            database.createObjectStore('annotations', { keyPath: 'documentId' });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          this.enabled = false;
          this.databasePromise = null;
          reject(request.error);
        };
        request.onblocked = () => {
          this.enabled = false;
          this.databasePromise = null;
          reject(new Error('IndexedDB 被其他标签页阻塞'));
        };
      });
    }

    return this.databasePromise;
  }

  async saveFile(record) {
    if (!this.enabled) {
      this.memoryFiles.set(record.id, record);
      return;
    }

    const database = await this.open();
    await this.runTransaction(database, 'files', 'readwrite', (store) => store.put(record));
  }

  async saveDocumentMeta(record) {
    const stored = await this.getFile(record.id);
    await this.saveFile({
      annotationsCount: 0,
      ...stored,
      ...record,
      bytes: stored?.bytes,
      updatedAt: record.updatedAt ?? Date.now()
    });
  }

  async saveDocumentBytes(record) {
    await this.saveFile(record);
  }

  async saveAnnotations(documentId, annotations, updatedAt = Date.now()) {
    const record = { documentId, annotations, updatedAt };

    if (!this.enabled) {
      this.memoryAnnotations.set(documentId, record);
      return;
    }

    const database = await this.open();
    await this.runTransaction(database, 'annotations', 'readwrite', (store) =>
      store.put(record)
    );
  }

  async getFile(documentId) {
    if (!this.enabled) {
      return this.memoryFiles.get(documentId) ?? null;
    }

    const database = await this.open();
    return this.runTransaction(database, 'files', 'readonly', (store) =>
      store.get(documentId)
    );
  }

  async listRecentFiles() {
    if (!this.enabled) {
      return [...this.memoryFiles.values()].sort(byMostRecent).map(toRecentRecord);
    }

    const database = await this.open();
    const records = await this.runTransaction(database, 'files', 'readonly', (store) =>
      store.getAll()
    );

    return records.sort(byMostRecent).map(toRecentRecord);
  }

  async getAnnotations(documentId) {
    if (!this.enabled) {
      return this.memoryAnnotations.get(documentId)?.annotations ?? {};
    }

    const database = await this.open();
    const record = await this.runTransaction(
      database,
      'annotations',
      'readonly',
      (store) => store.get(documentId)
    );

    return record?.annotations ?? {};
  }

  async clearDocument(documentId) {
    this.memoryFiles.delete(documentId);
    this.memoryAnnotations.delete(documentId);

    if (!this.enabled) {
      return;
    }

    const database = await this.open();
    await Promise.all([
      this.runTransaction(database, 'files', 'readwrite', (store) => store.delete(documentId)),
      this.runTransaction(database, 'annotations', 'readwrite', (store) =>
        store.delete(documentId)
      )
    ]);
  }

  runTransaction(database, storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = operation(store);

      transaction.oncomplete = () => resolve(request.result);
      request.onsuccess = () => {
        if (mode === 'readonly') {
          resolve(request.result);
        }
      };
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}

function toRecentRecord(record) {
  const { bytes: _bytes, ...recent } = record;
  return { ...recent, hasBytes: Boolean(_bytes), size: _bytes?.length ?? record.size ?? 0 };
}

function byMostRecent(left, right) {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
}

export function debounce(callback, delay = 350) {
  let timer = 0;

  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}
