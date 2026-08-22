import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Check, Clock, QrCode as QrIcon } from 'lucide-react';

interface QrCodeCardProps {
  joinUrl: string;
  numericCode: string;
  expiresAt: string | number;
  onExpire?: () => void;
}

export const QrCodeCard: React.FC<QrCodeCardProps> = ({
  joinUrl,
  numericCode,
  expiresAt,
  onExpire,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string>('');
  const [isExpired, setIsExpired] = useState(false);

  // Generate QR Canvas
  useEffect(() => {
    if (canvasRef.current && joinUrl) {
      QRCode.toCanvas(canvasRef.current, joinUrl, {
        width: 220,
        margin: 2,
        color: {
          dark: '#1a73e8', // Calm Pixel blue for QR dots
          light: '#ffffff',
        },
      }).catch((err) => console.error('QR rendering error:', err));
    }
  }, [joinUrl]);

  // Expiry Countdown Timer
  useEffect(() => {
    const target = typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : expiresAt;

    const updateTimer = () => {
      const remaining = Math.max(0, Math.floor((target - Date.now()) / 1000));
      if (remaining <= 0) {
        setIsExpired(true);
        setTimeLeft('00:00');
        onExpire?.();
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      setTimeLeft(`${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [expiresAt, onExpire]);

  const handleCopy = () => {
    navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col items-center rounded-xl bg-surface border border-surface-variant p-6 shadow-m3 max-w-sm w-full text-center transition-all">
      <div className="flex items-center gap-2 text-text-primary font-medium mb-1">
        <QrIcon className="h-4 w-4 text-primary" />
        <span>Scan with Phone Camera</span>
      </div>
      <p className="text-xs text-text-secondary mb-4">
        Point phone camera to transfer files instantly. No app required.
      </p>

      {/* QR Code Canvas */}
      <div className="relative rounded-lg bg-white p-2 border border-surface-variant shadow-sm mb-4">
        <canvas ref={canvasRef} className="rounded-md" />
        {isExpired && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface/90 backdrop-blur-xs rounded-lg p-4">
            <Clock className="h-8 w-8 text-error mb-2 animate-bounce" />
            <p className="font-semibold text-sm text-error">QR Expired</p>
          </div>
        )}
      </div>

      {/* Countdown Timer */}
      <div className="flex items-center gap-1.5 text-xs text-text-secondary font-medium bg-surface-variant px-3 py-1 rounded-pill mb-4">
        <Clock className="h-3.5 w-3.5 text-primary" />
        <span>Session expires in: <strong className="text-text-primary font-mono">{timeLeft}</strong></span>
      </div>

      {/* Numeric Backup Code & Copy URL */}
      <div className="w-full flex items-center justify-between bg-surface-variant/70 border border-surface-variant rounded-md px-3 py-2 text-xs">
        <div className="text-left">
          <span className="text-text-muted text-[10px] uppercase font-semibold tracking-wider">Backup Code</span>
          <p className="font-mono text-sm font-bold tracking-widest text-primary">{numericCode}</p>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 bg-surface border border-surface-variant hover:bg-surface-variant text-text-secondary px-2.5 py-1.5 rounded-pill transition-all btn-tactile text-xs font-medium"
          title="Copy customer link"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-success" />
              <span className="text-success font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy Link</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
