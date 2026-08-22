import React from 'react';
import { TransferProgress } from '@quickdrop/shared';
import { formatBytes, formatRemainingTime } from '../lib/transfer/sanitizer.js';
import { CheckCircle2, AlertTriangle, RefreshCw, Zap, Clock } from 'lucide-react';
import clsx from 'clsx';

interface TransferProgressCardProps {
  progress: TransferProgress;
  onCancel?: () => void;
}

export const TransferProgressCard: React.FC<TransferProgressCardProps> = ({ progress, onCancel }) => {
  const isComplete = progress.status === 'COMPLETED';
  const isFailed = progress.status === 'FAILED';
  const isVerifying = progress.status === 'VERIFYING';
  const isHashing = progress.status === 'HASHING';

  return (
    <div className="w-full rounded-xl border border-surface-variant bg-surface p-4 shadow-m3 transition-all">
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary" title={progress.fileName}>
            {progress.fileName}
          </p>
          <p className="text-xs text-text-secondary">
            {formatBytes(progress.transferredBytes)} of {formatBytes(progress.fileSize)}
          </p>
        </div>

        <div className="shrink-0">
          {isComplete && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-success-container px-2.5 py-0.5 text-xs font-semibold text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Verified
            </span>
          )}
          {isFailed && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-error-container px-2.5 py-0.5 text-xs font-semibold text-error">
              <AlertTriangle className="h-3.5 w-3.5" />
              Failed
            </span>
          )}
          {isVerifying && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-primary-container px-2.5 py-0.5 text-xs font-semibold text-primary">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Verifying SHA-256...
            </span>
          )}
          {isHashing && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-primary-container px-2.5 py-0.5 text-xs font-semibold text-primary">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Preparing Checksum...
            </span>
          )}
          {progress.status === 'QUEUED' && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-surface-variant px-2.5 py-0.5 text-xs font-semibold text-text-secondary">
              <Clock className="h-3.5 w-3.5" />
              Waiting in Queue...
            </span>
          )}
          {!isComplete && !isFailed && !isVerifying && !isHashing && progress.status !== 'QUEUED' && (
            <span className="text-xs font-bold text-primary font-mono">
              {progress.percentage}%
            </span>
          )}
        </div>
      </div>

      {/* Progress Track */}
      <div className="h-2.5 w-full overflow-hidden rounded-pill bg-surface-variant">
        <div
          className={clsx(
            'h-full rounded-pill transition-all duration-150 ease-out',
            isComplete ? 'bg-success' : isFailed ? 'bg-error' : 'bg-primary'
          )}
          style={{ width: `${progress.percentage}%` }}
        />
      </div>

      {/* Transfer Metrics Footer */}
      {!isComplete && !isFailed && (
        <div className="mt-2.5 flex items-center justify-between text-[11px] text-text-secondary">
          <div className="flex items-center gap-1.5 font-medium">
            <Zap className="h-3 w-3 text-primary" />
            <span>{formatBytes(progress.speedBytesPerSec)}/s</span>
          </div>

          <div className="flex items-center gap-2">
            <span>{formatRemainingTime(progress.estimatedRemainingSec)}</span>
            {onCancel && (
              <button
                onClick={onCancel}
                className="text-error hover:underline ml-2"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {isFailed && progress.error && (
        <p className="mt-2 text-xs text-error">{progress.error}</p>
      )}
    </div>
  );
};
