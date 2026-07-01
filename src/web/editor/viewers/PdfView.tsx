/**
 * PDF tab: the browser's built-in PDF plugin (page list, zoom, text search,
 * print) rendered in an iframe — full-featured without bundling a PDF engine.
 */
export function PdfView({ src, name }: { src: string; name: string }): JSX.Element {
  return (
    <div className="viewerStage pdfStage">
      <iframe src={src} title={name} className="pdfFrame" />
    </div>
  );
}
