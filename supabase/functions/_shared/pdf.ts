import * as pdfjsLib from "npm:pdfjs-dist@4.2.67/legacy/build/pdf.mjs";

type PdfTextResult = {
  text: string;
  pageCount: number;
};

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextResult> {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const pageTexts: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    const pageLines = textContent.items
      .map((item: unknown) => {
        const maybe = item as { str?: string };
        return maybe?.str ?? "";
      })
      .filter(Boolean);

    pageTexts.push(
      `\n===== PAGE ${pageNum} =====\n${pageLines.join(" ")}\n`
    );
  }

  return {
    text: pageTexts.join("\n"),
    pageCount: pdf.numPages,
  };
}