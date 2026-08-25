import React from 'react';
import { FileText, FileSpreadsheet, Image, FileCode, X, AlertTriangle } from 'lucide-react';
import { formatBytes } from '../lib/transfer/sanitizer.js';

interface FileItemCardProps {
  /** Name and size only — a restored batch row has metadata but no live File handle. */
  name: string;
  size: number;
  onRemove?: () => void;
  disabled?: boolean;
  /**
   * The bytes for this row are gone (page was refreshed), so it is shown as an
   * explicit "select this file again" row rather than a normal pending one.
   */
  needsReselect?: boolean;
}

export const FileItemCard: React.FC<FileItemCardProps> = ({
  name,
  size,
  onRemove,
  disabled,
  needsReselect,
}) => {
  const getFileIcon = () => {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf':
        return <FileText className="h-5 w-5 text-red-500" />;
      case 'doc':
      case 'docx':
        return <FileText className="h-5 w-5 text-blue-500" />;
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

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border bg-surface p-3 shadow-sm transition-all ${
        needsReselect
          ? 'border-warning/50 bg-warning-container/20'
          : 'border-surface-variant hover:border-primary/30'
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-variant">
          {needsReselect ? <AlertTriangle className="h-5 w-5 text-warning" /> : getFileIcon()}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary" title={name}>
            {name}
          </p>
          <p className="text-xs text-text-secondary">
            {needsReselect ? (
              <span className="text-warning font-medium">Select this file again to send it</span>
            ) : (
              formatBytes(size)
            )}
          </p>
        </div>
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-surface-variant hover:text-text-primary transition-all disabled:opacity-50 btn-tactile"
          aria-label={`Remove ${name}`}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
};
