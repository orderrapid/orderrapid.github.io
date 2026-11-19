// Background reader for uploaded Excel files.
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { parseWorkbook } from './excel.js';

self.onmessage = (e) => {
  const { buf, kind } = e.data;
  try {
    self.postMessage({ status: 'Checking rows…' });
    const result = parseWorkbook(XLSX, new Uint8Array(buf), kind);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
