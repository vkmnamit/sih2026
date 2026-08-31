/**
 * PDF service
 *
 *   Teacher uploads PDF
 *           ↓
 *      Detect PDF type  (per page!)
 *           ↓
 *    ┌───────────────┐
 *    │ Text PDF?     │
 *    └───────┬───────┘
 *       YES  │  NO
 *            ↓
 *     MuPDF (same engine as PyMuPDF)     OCR (tesseract.js)
 *            │                              │
 *            └──────────┬───────────────────┘
 *                       ↓
 *              Extracted text (page numbers preserved)
 *
 * OCR is a FALLBACK, not the default: only pages with little/no embedded text
 * are rasterized and OCR'd.
 */
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import { createWorker, type Worker } from 'tesseract.js';
import { config } from '../config/index.js';
import type {
  ExtractionMethod,
  PdfExtractionResult,
  PdfPage,
  Segment,
} from '../types/ingest.js';

/** Lazily-created, reused tesseract worker */
let ocrWorkerPromise: Promise<Worker> | null = null;

function getOcrWorker(): Promise<Worker> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker(config.ocrLang).catch((err: unknown) => {
      ocrWorkerPromise = null; // allow retry on next request
      throw err;
    });
  }
  return ocrWorkerPromise;
}

/** Count of alphanumeric characters — used to judge if a page has a text layer */
function alphanumericCount(text: string): number {
  return (text.match(/[a-zA-Z0-9]/g) ?? []).length;
}

/** A page is a "text page" if its embedded text layer has enough content */
function isTextPage(pageText: string): boolean {
  return alphanumericCount(pageText) >= config.ocrMinCharsPerPage;
}

/**
 * OCR a single page: rasterize with MuPDF at pdfRenderScale, then tesseract.
 */
async function ocrPage(page: mupdf.Page): Promise<string> {
  const bounds = page.getBounds();
  const matrix = mupdf.Matrix.scale(config.pdfRenderScale, config.pdfRenderScale);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    const png = pixmap.asPNG();
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(Buffer.from(png));
    return data.text ?? '';
  } finally {
    pixmap.destroy();
  }
}

export interface ExtractPdfOptions {
  onProgress?: (info: { page: number; totalPages: number; method: ExtractionMethod }) => void;
}

/**
 * Extract text from a PDF, page by page, with per-page OCR fallback.
 */
export async function extractPdf(
  filePath: string,
  { onProgress }: ExtractPdfOptions = {}
): Promise<PdfExtractionResult> {
  const data = fs.readFileSync(filePath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const totalPages = doc.countPages();

  const pages: PdfPage[] = [];
  let textPages = 0;
  let ocrPages = 0;

  try {
    for (let i = 0; i < totalPages; i += 1) {
      const page = doc.loadPage(i);

      // 1) Try the embedded text layer first (PyMuPDF-equivalent)
      let text = page.toStructuredText().asText().trim();
      let method: ExtractionMethod = 'mupdf';

      // 2) Fallback: scanned/image page -> OCR
      if (!isTextPage(text)) {
        try {
          const ocrText = await ocrPage(page);
          if (alphanumericCount(ocrText) > alphanumericCount(text)) {
            text = ocrText;
            method = 'ocr';
          }
        } catch (err) {
          // OCR failure must not kill the whole document — keep what we have
          console.error(`[pdf.service] OCR failed on page ${i + 1}:`, (err as Error).message);
        }
      }

      if (method === 'ocr') ocrPages += 1;
      else if (text) textPages += 1;

      const clean = text.replace(/[ \t]+/g, ' ').trim();
      pages.push({
        page: i + 1,
        text: clean,
        method,
        charCount: clean.length,
      });

      page.destroy();
      onProgress?.({ page: i + 1, totalPages, method });
    }
  } finally {
    doc.destroy();
  }

  return {
    pages,
    stats: {
      totalPages,
      textPages,
      ocrPages,
      totalChars: pages.reduce((sum, p) => sum + p.charCount, 0),
    },
  };
}

/**
 * Full PDF pipeline: extract → segments ready for chunking.
 * Completely empty pages are skipped so they don't pollute chunks.
 */
export async function extractPdfSegments(
  filePath: string,
  opts: ExtractPdfOptions = {}
): Promise<Segment[]> {
  const { pages } = await extractPdf(filePath, opts);
  return pages
    .filter((p) => p.text)
    .map((p) => ({
      text: p.text,
      meta: { page: p.page, extraction: p.method },
    }));
}
