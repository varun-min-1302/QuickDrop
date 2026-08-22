import React from 'react';
import { Printer, ShieldCheck, Sun, Moon } from 'lucide-react';

interface NavbarProps {
  onToggleTheme?: () => void;
  isDark?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({ onToggleTheme, isDark }) => {
  return (
    <header className="sticky top-0 z-30 w-full border-b border-surface-variant bg-surface/90 backdrop-blur-md px-4 sm:px-8 py-3.5 transition-colors print:hidden">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white shadow-sm">
            <Printer className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-lg tracking-tight text-text-primary">QuickDrop</span>
              <span className="inline-flex items-center gap-0.5 rounded-full bg-primary-container px-2 py-0.5 text-[11px] font-medium text-primary-on-container">
                <ShieldCheck className="h-3 w-3" /> P2P
              </span>
            </div>
            <p className="text-[11px] text-text-muted hidden sm:block">Scan. Send. Print.</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-text-secondary bg-surface-variant px-3 py-1.5 rounded-pill">
            <span className="h-2 w-2 rounded-full bg-success"></span>
            Zero Cloud Storage
          </div>

          {onToggleTheme && (
            <button
              onClick={onToggleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-variant text-text-secondary hover:text-text-primary btn-tactile"
              aria-label="Toggle theme"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
