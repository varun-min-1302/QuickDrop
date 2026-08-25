import React, { useState } from 'react';
import { ReceivedDocument } from '../lib/transfer/receiver.js';
import { formatBytes } from '../lib/transfer/sanitizer.js';
import { printDocument } from '../lib/printer/printHelper.js';
import { ExternalLink, Printer, Download, Trash2, CheckCircle2, FileText, Image, FileSpreadsheet, FileCode, RefreshCw } from 'lucide-react';

interface ReceivedFileCardProps {
  document: ReceivedDocument;
  /** Receives the durable documentId, not the transferId. */
  onDelete?: (documentId: string) => void;
}

export const ReceivedFileCard: React.FC<ReceivedFileCardProps> = ({ document, onDelete }) => {
  const [isPrinting, setIsPrinting] = useState(false);

  const getFileIcon = () => {
    const ext = document.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf':
        return <FileText className="h-5 w-5 text-red-500" />;
      case 'doc':
      case 'docx':
        return <FileText className="h-5 w-5 text-blue-500" />;
      case 'ppt':
      case 'pptx':
        return <FileText className="h-5 w-5 text-orange-500" />;
      case 'xls':
      case 'xlsx':
        return <FileSpreadsheet className="h-5 w-5 text-emerald-600" />;
      case 'jpg':
      case 'jpeg':
      case 'png':
        return <Image className="h-5 w-5 text-purple-500" />;
      default:
        return <FileCode className="h-5 w-5 text-gray-500" />;
    }
  };

  const handleOpen = () => {
    window.open(document.objectUrl, '_blank', 'noopener,noreferrer');
  };

  const handleDownload = () => {
    const link = window.document.createElement('a');
    link.href = document.objectUrl;
    link.download = document.name;
    window.document.body.appendChild(link);
    link.click();
    window.document.body.removeChild(link);
  };

  const handlePrint = async () => {
    if (isPrinting) return;
    setIsPrinting(true);
    try {
      await printDocument(document.file, document.objectUrl);
    } catch (err) {
      console.error('Print failed:', err);
    } finally {
      setTimeout(() => setIsPrinting(false), 1000);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-surface-variant bg-surface p-4 shadow-m3 transition-all hover:border-primary/40">
      <div className="flex items-start gap-3.5 min-w-0">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-variant">
          {getFileIcon()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="truncate text-sm font-semibold text-text-primary" title={document.name}>
              {document.name}
            </h4>
            <span className="inline-flex items-center gap-1 rounded-pill bg-success-container px-2 py-0.5 text-[11px] font-semibold text-success">
              <CheckCircle2 className="h-3 w-3" /> Ready to Print
            </span>
          </div>
          <p className="text-xs text-text-secondary mt-0.5">
            {formatBytes(document.size)} • Received at {document.receivedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </p>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 self-end sm:self-auto shrink-0 flex-wrap">
        <button
          onClick={handleOpen}
          className="inline-flex items-center gap-1.5 rounded-pill bg-surface-variant hover:bg-surface-elevated text-text-primary px-3 py-1.5 text-xs font-medium border border-surface-variant transition-all btn-tactile shadow-xs"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span>Open</span>
        </button>

        <button
          onClick={handlePrint}
          disabled={isPrinting}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary hover:bg-primary-hover text-white px-3.5 py-1.5 text-xs font-medium transition-all btn-tactile shadow-sm disabled:opacity-75"
        >
          {isPrinting ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Printer className="h-3.5 w-3.5" />
          )}
          <span>{isPrinting ? 'Preparing...' : 'Print'}</span>
        </button>

        <button
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 rounded-pill bg-surface-variant hover:bg-surface-elevated text-text-primary px-3 py-1.5 text-xs font-medium border border-surface-variant transition-all btn-tactile shadow-xs"
          title="Save file to computer"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Save</span>
        </button>

        {onDelete && (
          <button
            onClick={() => onDelete(document.documentId)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-error-container hover:text-error transition-all btn-tactile"
            title="Delete from browser"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
};
