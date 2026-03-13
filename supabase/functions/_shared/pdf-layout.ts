import * as pdfjsLib from "npm:pdfjs-dist@4.2.67/legacy/build/pdf.mjs";

export type PdfTextItem = {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfLayoutResult = {
  pageCount: number;
  items: PdfTextItem[];
  plainText: string;
};

export async function extractPdfLayout(bytes: Uint8Array): Promise<PdfLayoutResult> {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const items: PdfTextItem[] = [];
  const plainPages: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    const pageItems: PdfTextItem[] = [];

    for (const raw of textContent.items as Array<Record<string, unknown>>) {
      const str = String(raw.str ?? "").trim();
      if (!str) continue;

      const transform = (raw.transform as number[]) || [0, 0, 0, 0, 0, 0];
      const width = Number(raw.width ?? 0);
      const height = Number(raw.height ?? 0);

      pageItems.push({
        page: pageNum,
        text: str,
        x: Number(transform[4] ?? 0),
        y: Number(transform[5] ?? 0),
        width,
        height,
      });
    }

    // Sort top-to-bottom, left-to-right for human-readable fallback text
    pageItems.sort((a, b) => {
      if (Math.abs(b.y - a.y) > 2) return b.y - a.y;
      return a.x - b.x;
    });

    items.push(...pageItems);

    const pageText = pageItems.map((i) => i.text).join(" ");
    plainPages.push(`===== PAGE ${pageNum} =====\n${pageText}`);
  }

  return {
    pageCount: pdf.numPages,
    items,
    plainText: plainPages.join("\n\n"),
  };
}