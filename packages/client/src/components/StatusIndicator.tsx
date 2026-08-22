import React from 'react';
import { Wifi, WifiOff, RefreshCw, CheckCircle2, Clock } from 'lucide-react';
import clsx from 'clsx';

export type AppConnectionState =
  | 'IDLE'
  | 'INITIALIZING'
  | 'CONNECTING'
  | 'READY'
  | 'CUSTOMER_CONNECTED'
  | 'TRANSFERRING'
  | 'COMPLETED'
  | 'UNSTABLE'
  | 'EXPIRED'
  | 'DISCONNECTED';

interface StatusIndicatorProps {
  state: AppConnectionState;
  customLabel?: string;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ state, customLabel }) => {
  const getStatusConfig = () => {
    switch (state) {
      case 'READY':
        return {
          dotClass: 'bg-primary animate-pulse',
          bgClass: 'bg-primary-container text-primary-on-container',
          icon: <Wifi className="h-3.5 w-3.5" />,
          label: customLabel || 'Ready — Waiting for scan',
        };
      case 'CUSTOMER_CONNECTED':
        return {
          dotClass: 'bg-success',
          bgClass: 'bg-success-container text-success',
          icon: <CheckCircle2 className="h-3.5 w-3.5" />,
          label: customLabel || 'Customer Connected',
        };
      case 'TRANSFERRING':
        return {
          dotClass: 'bg-primary animate-ping',
          bgClass: 'bg-primary-container text-primary-on-container',
          icon: <RefreshCw className="h-3.5 w-3.5 animate-spin" />,
          label: customLabel || 'Transferring Documents...',
        };
      case 'COMPLETED':
        return {
          dotClass: 'bg-success',
          bgClass: 'bg-success-container text-success',
          icon: <CheckCircle2 className="h-3.5 w-3.5" />,
          label: customLabel || 'Transfer Complete',
        };
      case 'CONNECTING':
      case 'INITIALIZING':
        return {
          dotClass: 'bg-warning',
          bgClass: 'bg-warning-container text-warning',
          icon: <RefreshCw className="h-3.5 w-3.5 animate-spin" />,
          label: customLabel || 'Connecting P2P...',
        };
      case 'EXPIRED':
        return {
          dotClass: 'bg-error',
          bgClass: 'bg-error-container text-error',
          icon: <Clock className="h-3.5 w-3.5" />,
          label: customLabel || 'Session Expired',
        };
      case 'UNSTABLE':
      case 'DISCONNECTED':
      default:
        return {
          dotClass: 'bg-error',
          bgClass: 'bg-error-container text-error',
          icon: <WifiOff className="h-3.5 w-3.5" />,
          label: customLabel || 'Disconnected',
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-2 rounded-pill px-3 py-1 text-xs font-medium transition-all shadow-sm',
        config.bgClass
      )}
      role="status"
      aria-live="polite"
    >
      <span className={clsx('h-2 w-2 rounded-full', config.dotClass)} aria-hidden="true" />
      <span className="flex items-center gap-1.5 font-medium">
        {config.icon}
        {config.label}
      </span>
    </div>
  );
};
