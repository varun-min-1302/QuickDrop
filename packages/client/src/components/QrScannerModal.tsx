import React, { useState, useEffect, useRef } from 'react';
import jsQR from 'jsqr';
import { Camera, ArrowLeft, AlertCircle, KeyRound, RefreshCw, X } from 'lucide-react';
import { parseAndValidateQuickDropQr, QrScanResult } from '../lib/qr/qrValidator.js';

interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fired with a validated, classified scan result: either the permanent shop QR
   * (`kind: 'shop'`) or a legacy ephemeral session token (`kind: 'token'`). The caller
   * routes accordingly.
   */
  onScanSuccess: (result: QrScanResult) => void;
  onSwitchToManualCode: () => void;
}

type ScannerStatus =
  | 'STARTING'
  | 'SCANNING'
  | 'PROCESSING'
  | 'PERMISSION_DENIED'
  | 'UNAVAILABLE';

export const QrScannerModal: React.FC<QrScannerModalProps> = ({
  isOpen,
  onClose,
  onScanSuccess,
  onSwitchToManualCode,
}) => {
  const [status, setStatus] = useState<ScannerStatus>('STARTING');
  const [invalidMsg, setInvalidMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      return;
    }

    startCamera();

    return () => {
      stopCamera();
    };
  }, [isOpen]);

  const stopCamera = () => {
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
      animFrameIdRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    isProcessingRef.current = false;
  };

  const startCamera = async () => {
    stopCamera();
    setStatus('STARTING');
    setInvalidMsg(null);
    isProcessingRef.current = false;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('UNAVAILABLE');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true'); // Required for iOS/Safari
        await videoRef.current.play();
        setStatus('SCANNING');
        startScanLoop();
      }
    } catch (err: any) {
      console.warn('Camera access error:', err?.name || err?.message);
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        setStatus('PERMISSION_DENIED');
      } else {
        setStatus('UNAVAILABLE');
      }
    }
  };

  const startScanLoop = () => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const scanFrame = async () => {
      if (!videoRef.current || videoRef.current.readyState !== videoRef.current.HAVE_ENOUGH_DATA) {
        animFrameIdRef.current = requestAnimationFrame(scanFrame);
        return;
      }

      if (isProcessingRef.current) {
        return;
      }

      const video = videoRef.current;
      const width = video.videoWidth;
      const height = video.videoHeight;

      if (width > 0 && height > 0 && ctx) {
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(video, 0, 0, width, height);

        const imageData = ctx.getImageData(0, 0, width, height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code && code.data && !isProcessingRef.current) {
          handleDetectedQr(code.data);
          return;
        }
      }

      animFrameIdRef.current = requestAnimationFrame(scanFrame);
    };

    animFrameIdRef.current = requestAnimationFrame(scanFrame);
  };

  const handleDetectedQr = (rawQrText: string) => {
    if (isProcessingRef.current) return;

    const validation = parseAndValidateQuickDropQr(rawQrText, window.location.origin);
    if (!validation.valid) {
      setInvalidMsg(validation.error || "This QR code isn't a QuickDrop shop QR.");
      setTimeout(() => setInvalidMsg(null), 2500);
      return;
    }

    const result: QrScanResult | null =
      validation.kind === 'shop' && validation.publicShopId
        ? { kind: 'shop', publicShopId: validation.publicShopId }
        : validation.kind === 'token' && validation.token
        ? { kind: 'token', token: validation.token }
        : null;

    if (!result) {
      setInvalidMsg("This QR code isn't a QuickDrop shop QR.");
      setTimeout(() => setInvalidMsg(null), 2500);
      return;
    }

    // Valid QR detected: stop camera immediately to prevent duplicate joins
    isProcessingRef.current = true;
    setStatus('PROCESSING');
    stopCamera();

    // Trigger join / bridge
    onScanSuccess(result);
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-scanner-title"
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-md animate-in fade-in duration-200"
    >
      {/* Header Bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-variant bg-surface safe-top">
        <button
          onClick={onClose}
          className="flex items-center gap-2 rounded-pill bg-surface-variant/60 hover:bg-surface-variant text-text-primary px-3.5 py-2 text-xs font-semibold transition-all touch-target"
          aria-label="Close QR scanner and go back"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back</span>
        </button>

        <h2 id="qr-scanner-title" className="text-sm font-bold text-text-primary">
          Scan Shop QR Code
        </h2>

        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-variant/40 text-text-secondary hover:text-text-primary transition-colors touch-target"
          aria-label="Close scanner"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Main Scanner Container */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 relative overflow-hidden">
        {/* Active Camera View */}
        {(status === 'SCANNING' || status === 'PROCESSING' || status === 'STARTING') && (
          <div className="relative w-full max-w-sm aspect-square rounded-3xl overflow-hidden bg-black shadow-2xl border border-surface-variant">
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              muted
              playsInline
            />

            {/* Viewfinder Target Framing with Pixel / Material 3 Style */}
            {status === 'SCANNING' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-8">
                <div className="relative w-full h-full border-2 border-dashed border-white/60 rounded-2xl">
                  {/* Subtle Corner Brackets */}
                  <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-primary rounded-tl-lg" />
                  <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-primary rounded-tr-lg" />
                  <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-primary rounded-bl-lg" />
                  <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-primary rounded-br-lg" />
                </div>
              </div>
            )}

            {/* Loading / Processing Indicator */}
            {(status === 'STARTING' || status === 'PROCESSING') && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-xs text-white space-y-3">
                <RefreshCw className="h-8 w-8 animate-spin text-primary" />
                <span className="text-xs font-semibold">
                  {status === 'STARTING' ? 'Starting camera...' : 'Connecting to shop counter...'}
                </span>
              </div>
            )}

            {/* Invalid QR Toast Overlay */}
            {invalidMsg && (
              <div className="absolute top-4 left-4 right-4 bg-error text-white text-xs font-medium py-2.5 px-3 rounded-xl shadow-lg flex items-center gap-2 animate-in slide-in-from-top-2 duration-150">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{invalidMsg}</span>
              </div>
            )}
          </div>
        )}

        {/* Permission Denied Fallback */}
        {status === 'PERMISSION_DENIED' && (
          <div className="rounded-3xl border border-surface-variant bg-surface p-6 shadow-m3 text-center space-y-4 max-w-sm w-full">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-error-container text-error mx-auto">
              <Camera className="h-7 w-7" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-bold text-text-primary">Camera Access Needed</h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                Camera access is needed to scan the shop QR code. You can enable camera permissions in your browser settings or enter the 6-character backup code.
              </p>
            </div>
            <div className="pt-2 space-y-2">
              <button
                onClick={onSwitchToManualCode}
                className="w-full flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-3.5 text-xs font-semibold btn-tactile shadow-sm touch-target"
              >
                <KeyRound className="h-4 w-4" />
                <span>Enter Backup Code Instead</span>
              </button>
            </div>
          </div>
        )}

        {/* Camera Unavailable Fallback */}
        {status === 'UNAVAILABLE' && (
          <div className="rounded-3xl border border-surface-variant bg-surface p-6 shadow-m3 text-center space-y-4 max-w-sm w-full">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-variant text-text-secondary mx-auto">
              <Camera className="h-7 w-7" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-bold text-text-primary">Camera Not Available</h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                Camera scanning isn't available on this device or browser.
              </p>
            </div>
            <div className="pt-2">
              <button
                onClick={onSwitchToManualCode}
                className="w-full flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-3.5 text-xs font-semibold btn-tactile shadow-sm touch-target"
              >
                <KeyRound className="h-4 w-4" />
                <span>Enter Backup Code</span>
              </button>
            </div>
          </div>
        )}

        {/* Bottom Helper Controls */}
        {status === 'SCANNING' && (
          <div className="mt-6 text-center space-y-4 max-w-xs w-full">
            <p className="text-xs text-text-secondary leading-relaxed">
              Point your phone camera at the QuickDrop QR code on the shop counter.
            </p>
            <button
              onClick={onSwitchToManualCode}
              className="inline-flex items-center gap-2 text-xs font-semibold text-primary hover:underline p-2 touch-target"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>Enter 6-character backup code instead</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
