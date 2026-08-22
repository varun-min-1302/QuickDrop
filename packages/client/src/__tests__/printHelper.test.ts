import { describe, it, expect, vi, beforeEach } from 'vitest';
import { printDocument } from '../lib/printer/printHelper.js';

describe('Client-Side Browser Print Helper', () => {
  beforeEach(() => {
    // Mock minimal document & iframe for node environment
    const mockIframe: any = {
      style: {},
      src: '',
      contentWindow: {
        focus: vi.fn(),
        print: vi.fn(),
        document: {
          open: vi.fn(),
          write: vi.fn(),
          close: vi.fn(),
          getElementById: vi.fn().mockReturnValue({}),
        },
      },
      contentDocument: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        getElementById: vi.fn().mockReturnValue({}),
      },
    };

    (globalThis as any).document = {
      createElement: vi.fn().mockReturnValue(mockIframe),
      body: {
        appendChild: vi.fn().mockImplementation((el) => {
          if (el.onload) el.onload();
          return el;
        }),
        removeChild: vi.fn(),
      },
    };
  });

  it('handles PDF printing via iframe', async () => {
    const file = new File(['%PDF-1.4 mock content'], 'invoice.pdf', { type: 'application/pdf' });
    const objectUrl = 'blob:http://localhost/test-pdf';

    const appendChildSpy = vi.spyOn(document.body, 'appendChild');
    
    // Trigger print
    await printDocument(file, objectUrl);
    expect(appendChildSpy).toHaveBeenCalled();
  });

  it('handles Image printing via styled print container', async () => {
    const file = new File(['mock-image-bytes'], 'receipt.png', { type: 'image/png' });
    const objectUrl = 'blob:http://localhost/test-png';

    const appendChildSpy = vi.spyOn(document.body, 'appendChild');
    await printDocument(file, objectUrl);
    expect(appendChildSpy).toHaveBeenCalled();
  });

  it('handles Plain Text printing', async () => {
    const file = new File(['Hello, this is printed text'], 'notes.txt', { type: 'text/plain' });
    const objectUrl = 'blob:http://localhost/test-txt';

    const appendChildSpy = vi.spyOn(document.body, 'appendChild');
    await printDocument(file, objectUrl);
    expect(appendChildSpy).toHaveBeenCalled();
  });
});
