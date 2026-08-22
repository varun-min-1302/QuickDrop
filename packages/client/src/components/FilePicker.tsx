import React, { useRef, useState } from 'react';
import { UploadCloud, AlertCircle } from 'lucide-react';
import { isAllowedFile, formatBytes } from '../lib/transfer/sanitizer.js';
import { LIMITS } from '@quickdrop/shared';
import clsx from 'clsx';

interface FilePickerProps {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
}

export const FilePicker: React.FC<FilePickerProps> = ({ onFilesSelected, disabled }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFiles = (incomingList: FileList | File[]) => {
    setErrorMessage(null);
    const validFiles: File[] = [];

    for (let i = 0; i < incomingList.length; i++) {
      const file = incomingList[i];
      const check = isAllowedFile(file.name, file.size);
      if (!check.valid) {
        setErrorMessage(check.error || 'Invalid file');
        return;
      }
      validFiles.push(file);
    }

    if (validFiles.length > LIMITS.MAX_FILES_PER_SESSION) {
      setErrorMessage(`Maximum ${LIMITS.MAX_FILES_PER_SESSION} files allowed at once.`);
      return;
    }

    onFilesSelected(validFiles);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  };

  return (
    <div className="w-full space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (!disabled) fileInputRef.current?.click();
        }}
        className={clsx(
          'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-all',
          disabled ? 'opacity-50 cursor-not-allowed bg-surface-variant/30 border-surface-variant' : 'btn-tactile hover:bg-primary-container/20',
          isDragOver
            ? 'border-primary bg-primary-container/30 scale-[1.01]'
            : 'border-surface-variant bg-surface'
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={disabled}
          onChange={handleChange}
          accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.jpg,.jpeg,.png,.txt"
          className="hidden"
        />

        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-container text-primary mb-3 shadow-xs">
          <UploadCloud className="h-7 w-7" />
        </div>

        <h3 className="text-base font-semibold text-text-primary mb-1">
          Tap to Select Documents
        </h3>
        <p className="text-xs text-text-secondary mb-3">
          or drag and drop files here
        </p>

        <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-text-muted">
          <span className="bg-surface-variant px-2 py-0.5 rounded-pill font-medium">PDF</span>
          <span className="bg-surface-variant px-2 py-0.5 rounded-pill font-medium">DOCX</span>
          <span className="bg-surface-variant px-2 py-0.5 rounded-pill font-medium">XLSX</span>
          <span className="bg-surface-variant px-2 py-0.5 rounded-pill font-medium">PPTX</span>
          <span className="bg-surface-variant px-2 py-0.5 rounded-pill font-medium">Images</span>
          <span className="text-text-secondary ml-1">• Up to {formatBytes(LIMITS.MAX_FILE_SIZE_BYTES)} per file</span>
        </div>
      </div>

      {errorMessage && (
        <div className="flex items-center gap-2 rounded-lg bg-error-container p-3 text-xs text-error">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
};
