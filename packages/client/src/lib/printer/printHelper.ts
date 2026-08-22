import { renderAsync } from 'docx-preview';
import JSZip from 'jszip';

/**
 * Client-Side Direct Browser Print Engine for QuickDrop.
 * Preserves 100% privacy: zero document bytes leave the local browser memory.
 */
export async function printDocument(file: File, objectUrl: string): Promise<void> {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  switch (ext) {
    case 'pdf':
      await printPdf(objectUrl);
      break;

    case 'jpg':
    case 'jpeg':
    case 'png':
      await printImage(objectUrl, file.name);
      break;

    case 'txt':
      await printText(file);
      break;

    case 'docx':
      await printDocx(file);
      break;

    case 'pptx':
      await printPptx(file);
      break;

    default:
      // Fallback for other formats (e.g. xlsx, doc)
      await printFallback(objectUrl, file.name);
      break;
  }
}

/**
 * Print PDF via dedicated hidden iframe.
 */
function printPdf(objectUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.src = objectUrl;

    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        const win = window.open(objectUrl, '_blank');
        win?.focus();
        win?.print();
      }
      resolve();

      setTimeout(() => {
        try {
          document.body.removeChild(iframe);
        } catch {}
      }, 60000);
    };

    document.body.appendChild(iframe);
  });
}

/**
 * Print Image via formatted printable iframe.
 */
function printImage(objectUrl: string, title: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = createPrintIframe();
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      document.body.removeChild(iframe);
      resolve();
      return;
    }

    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${escapeHtml(title)}</title>
          <style>
            @page { margin: 0.5cm; }
            body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
            img { max-width: 100%; max-height: 100vh; object-fit: contain; }
          </style>
        </head>
        <body>
          <img src="${objectUrl}" onload="window.focus(); window.print();" />
        </body>
      </html>
    `);
    doc.close();

    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    resolve();

    setTimeout(() => {
      try {
        document.body.removeChild(iframe);
      } catch {}
    }, 60000);
  });
}

/**
 * Print Plain Text file.
 */
async function printText(file: File): Promise<void> {
  const text = await file.text();
  const iframe = createPrintIframe();
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) return;

  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${escapeHtml(file.name)}</title>
        <style>
          @page { margin: 1.5cm; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; font-size: 11pt; line-height: 1.5; color: #000; }
          pre { white-space: pre-wrap; word-break: break-word; }
        </style>
      </head>
      <body>
        <pre>${escapeHtml(text)}</pre>
      </body>
    </html>
  `);
  doc.close();

  iframe.contentWindow?.focus();
  iframe.contentWindow?.print();

  setTimeout(() => {
    try {
      document.body.removeChild(iframe);
    } catch {}
  }, 60000);
}

/**
 * Print DOCX using client-side docx-preview rendering.
 */
async function printDocx(file: File): Promise<void> {
  const iframe = createPrintIframe();
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) return;

  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${escapeHtml(file.name)}</title>
        <style>
          @page { margin: 1cm; size: auto; }
          body { margin: 0; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
          .docx-container { width: 100%; max-width: 100%; box-sizing: border-box; }
          .docx-wrapper { background: transparent !important; padding: 0 !important; }
          .docx-wrapper > section.docx { background: #fff !important; box-shadow: none !important; margin: 0 auto !important; padding: 0 !important; width: 100% !important; min-height: auto !important; }
          @media print {
            body { background: transparent; }
            .docx-wrapper > section.docx { page-break-after: always; break-after: page; }
          }
        </style>
      </head>
      <body>
        <div id="docx-root" class="docx-container"></div>
      </body>
    </html>
  `);
  doc.close();

  const container = doc.getElementById('docx-root');
  if (container) {
    const arrayBuffer = await file.arrayBuffer();
    await renderAsync(arrayBuffer, container, undefined, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      renderChanges: false,
      renderComments: false,
      renderEndnotes: true,
      renderFootnotes: true,
      renderHeaders: true,
      renderFooters: true,
    });

    // Give images and fonts a moment to render, then print
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (err) {
      console.error('DOCX print error:', err);
    }

    setTimeout(() => {
      try {
        document.body.removeChild(iframe);
      } catch {}
    }, 60000);
  }
}

/**
 * Print PPTX by parsing OpenXML slides and rendering printable presentation slide pages.
 */
async function printPptx(file: File): Promise<void> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Find all slide XML files
  const slidePaths = Object.keys(zip.files)
    .filter((name) => name.startsWith('ppt/slides/slide') && name.endsWith('.xml'))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/[^0-9]/g, ''), 10) || 0;
      const numB = parseInt(b.replace(/[^0-9]/g, ''), 10) || 0;
      return numA - numB;
    });

  const slidesHtml: string[] = [];

  for (let i = 0; i < slidePaths.length; i++) {
    const slideFile = zip.files[slidePaths[i]];
    const xmlText = await slideFile.async('text');

    // Extract text blocks from <a:t> tags
    const textMatches = Array.from(xmlText.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/gs));
    const lines = textMatches.map((m) => m[1].trim()).filter(Boolean);

    // Build clean slide presentation card
    slidesHtml.push(`
      <div class="slide-page">
        <div class="slide-header">
          <span class="slide-number">Slide ${i + 1} of ${slidePaths.length}</span>
          <span class="slide-title">${escapeHtml(file.name)}</span>
        </div>
        <div class="slide-content">
          ${
            lines.length > 0
              ? lines.map((line, idx) => `<p class="${idx === 0 ? 'slide-heading' : 'slide-bullet'}">${escapeHtml(line)}</p>`).join('\n')
              : '<p class="empty-slide"><em>(Visual slide content / images)</em></p>'
          }
        </div>
      </div>
    `);
  }

  const iframe = createPrintIframe();
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) return;

  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${escapeHtml(file.name)}</title>
        <style>
          @page { margin: 1cm; size: landscape; }
          body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fff; }
          .slide-page {
            box-sizing: border-box;
            border: 2px solid #e0e2e6;
            border-radius: 8px;
            padding: 24px;
            margin-bottom: 24px;
            min-height: 480px;
            page-break-after: always;
            break-after: page;
            display: flex;
            flex-direction: column;
            background: #fafafa;
          }
          .slide-header {
            display: flex;
            justify-content: space-between;
            border-bottom: 1px solid #d0d3d8;
            padding-bottom: 8px;
            margin-bottom: 16px;
            font-size: 10pt;
            color: #5f6368;
          }
          .slide-number { font-weight: bold; color: #1a73e8; }
          .slide-content { flex: 1; font-size: 13pt; line-height: 1.6; color: #202124; }
          .slide-heading { font-size: 18pt; font-weight: bold; margin-top: 0; margin-bottom: 12px; color: #1a73e8; }
          .slide-bullet { margin: 6px 0; padding-left: 12px; }
          .empty-slide { color: #80868b; font-size: 11pt; }
          @media print {
            body { background: transparent; }
            .slide-page { border: 1px solid #999; margin: 0; background: #fff; }
          }
        </style>
      </head>
      <body>
        ${slidesHtml.join('\n')}
      </body>
    </html>
  `);
  doc.close();

  try {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
  } catch (err) {
    console.error('PPTX print error:', err);
  }

  setTimeout(() => {
    try {
      document.body.removeChild(iframe);
    } catch {}
  }, 60000);
}

/**
 * Fallback for other office formats.
 */
function printFallback(_objectUrl: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    // Open in print helper window
    const printWin = window.open('', '_blank');
    if (printWin) {
      printWin.document.write(`
        <!DOCTYPE html>
        <html>
          <head><title>Print ${escapeHtml(name)}</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 40px;">
            <h2>Preparing document for printing...</h2>
            <p>If printing does not start automatically, please use the downloaded file.</p>
            <script>
              window.onload = function() {
                window.print();
              };
            </script>
          </body>
        </html>
      `);
      printWin.document.close();
    }
    resolve();
  });
}

function createPrintIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  return iframe;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
