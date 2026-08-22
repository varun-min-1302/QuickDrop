# QuickDrop --- Frontend Specification

**UI Direction:** Google Pixel / Material 3-inspired\
**Design personality:** Clean, friendly, quiet, tactile, modern\
**Avoid:** Cyberpunk, neon, excessive gradients, glass-heavy effects,
overly futuristic HUDs.

## 1. Design Goal

The interface should feel like a polished Google Pixel utility:

-   Clear hierarchy.
-   Rounded surfaces.
-   Comfortable spacing.
-   Large touch targets.
-   Subtle elevation.
-   Natural motion.
-   Strong typography.
-   Minimal chrome.
-   Helpful status feedback.

The design should prioritize the document-transfer action over branding.

## 2. Design Language

Use a Material 3-inspired system:

``` text
Rounded cards
Soft surfaces
Dynamic-looking tonal hierarchy
Large primary action
Compact supporting text
Subtle shadows/elevation
Smooth state transitions
```

Do not copy Google's exact proprietary product UI or assets. Use the
visual principles as inspiration.

## 3. Color System

Use semantic tokens rather than hard-coded colors.

### Light

``` text
Background:        warm/neutral near-white
Surface:           slightly elevated neutral
Surface Variant:   muted neutral
Primary:           calm Pixel-like blue
On Primary:        white
Success:           green semantic
Warning:           amber semantic
Error:             red semantic
Text Primary:      near-black
Text Secondary:    neutral gray
```

### Dark

``` text
Background:        deep neutral
Surface:           elevated dark neutral
Primary:           soft blue
Text Primary:      near-white
Text Secondary:    muted gray
```

Use CSS variables:

``` css
:root {
  --color-background: ...;
  --color-surface: ...;
  --color-surface-variant: ...;
  --color-primary: ...;
  --color-on-primary: ...;
  --color-success: ...;
  --color-error: ...;
}
```

## 4. Typography

Recommended:

``` text
Font family:
Inter / system-ui / sans-serif

Display:
Large and friendly

Headline:
Strong but not oversized

Body:
Readable 16px baseline

Label:
13–14px
```

For the shop dashboard, information density can be slightly higher.

## 5. Shape System

Recommended:

``` text
Small: 8px
Medium: 12px
Large: 16px
Extra Large: 24px
Pill: 999px
```

Primary upload area:

`24px radius`

Document cards:

`16px radius`

Buttons:

`999px pill` for prominent actions.

## 6. Elevation

Use subtle shadows.

Avoid large floating shadows.

Example:

``` text
Level 0 — flat background
Level 1 — document cards
Level 2 — important dialog
Level 3 — modal/overlay
```

## 7. Customer Page Layout

### Mobile-first

``` text
┌───────────────────────────────┐
│                               │
│ QuickDrop                     │
│                               │
│ Send documents to this shop   │
│                               │
│ ┌───────────────────────────┐ │
│ │                           │ │
│ │      ↑                    │ │
│ │   Select documents        │ │
│ │                           │ │
│ │ PDF · DOCX · Images       │ │
│ │                           │ │
│ └───────────────────────────┘ │
│                               │
│ Selected files                │
│                               │
│ ┌───────────────────────────┐ │
│ │ 📄 assignment.pdf         │ │
│ │    2.4 MB                 │ │
│ └───────────────────────────┘ │
│                               │
│ ┌───────────────────────────┐ │
│ │          Send             │ │
│ └───────────────────────────┘ │
│                               │
│ No account required           │
│                               │
└───────────────────────────────┘
```

## 8. Upload Component

The upload area must support:

-   Tap to choose files.
-   Drag/drop on desktop.
-   Multiple selection.
-   Clear validation errors.
-   File size.
-   File type.
-   Remove file.

### Empty state

``` text
Select documents

PDF, DOCX, PPTX, XLSX, JPG, PNG
Up to 50 MB per file
```

## 9. Transfer Card

``` text
┌──────────────────────────────────┐
│ 📄 assignment.pdf                │
│                                  │
│ 72%                              │
│ ███████████████░░░░              │
│                                  │
│ 1.7 MB / 2.4 MB                  │
│ 1.8 MB/s · 0.4 sec left          │
└──────────────────────────────────┘
```

Progress should animate smoothly but must not cause expensive
re-renders.

## 10. Success State

Use a subtle checkmark animation.

``` text
✓

Document sent

The shop received
assignment.pdf

You can close this page.
```

Do not use confetti or excessive animation.

## 11. Shop Dashboard

Desktop-first.

``` text
┌─────────────────────────────────────────────────────┐
│ QuickDrop                         ● Ready           │
├─────────────────────────────────────────────────────┤
│                                                     │
│            Scan to send documents                   │
│                                                     │
│                  ┌─────────┐                        │
│                  │         │                        │
│                  │   QR    │                        │
│                  │         │                        │
│                  └─────────┘                        │
│                                                     │
│             Expires in 14:32                       │
│                                                     │
├─────────────────────────────────────────────────────┤
│ Incoming documents                                  │
│                                                     │
│ assignment.pdf                                      │
│ PDF · 2.4 MB · Received                             │
│                                                     │
│ [ Open ] [ Print ]                                  │
└─────────────────────────────────────────────────────┘
```

## 12. Shop Navigation

MVP should keep navigation minimal:

``` text
QuickDrop
────────────────
Receive
Settings
```

No complex sidebar is required.

## 13. QR Component

QR card should contain:

``` text
QR
Scan with your phone

Session expires in:
14:32
```

Include a manual fallback code for accessibility/troubleshooting:

``` text
Code: X7K92P
```

Do not make the code easy to guess.

## 14. Status Indicator

Use icon + text.

``` text
● Ready
● Customer connected
● Receiving
✓ Received
⚠ Connection unstable
× Session expired
```

Never rely on color alone.

## 15. Responsive Breakpoints

``` text
Mobile:
< 640px

Tablet:
640–1024px

Desktop:
> 1024px
```

Customer UI is mobile-first.

Shop UI is desktop-first but must remain usable on tablets.

## 16. Accessibility

Minimum:

-   Keyboard support.
-   Visible focus ring.
-   Semantic buttons.
-   Proper labels.
-   `aria-live` for transfer status.
-   Reduced motion support.
-   44px+ touch targets.
-   Good contrast.
-   Error messages associated with controls.

## 17. Motion

Motion should communicate state.

### QR appears

Subtle fade + scale.

### File added

Small slide/fade.

### Transfer

Progress transition.

### Complete

Small checkmark draw/scale.

### Avoid

-   Constant floating animation.
-   Neon glow.
-   Rotating 3D objects.
-   Heavy blur.
-   Decorative particles.

## 18. Components

Recommended structure:

``` text
src/
├── app/
│   ├── router.tsx
│   └── providers.tsx
│
├── pages/
│   ├── JoinPage.tsx
│   ├── CustomerTransferPage.tsx
│   └── ShopPage.tsx
│
├── components/
│   ├── FilePicker.tsx
│   ├── FileCard.tsx
│   ├── TransferCard.tsx
│   ├── ProgressBar.tsx
│   ├── QrSessionCard.tsx
│   ├── ConnectionStatus.tsx
│   └── EmptyState.tsx
│
├── features/
│   ├── session/
│   ├── webrtc/
│   └── transfers/
│
├── lib/
│   ├── api.ts
│   ├── websocket.ts
│   ├── webrtc.ts
│   ├── hashing.ts
│   └── validation.ts
│
└── styles/
    └── tokens.css
```

## 19. State Model

Use explicit state machines rather than many independent booleans.

### Connection

``` text
idle
joining
signaling
connecting
connected
reconnecting
failed
closed
```

### Transfer

``` text
queued
validating
sending
verifying
completed
failed
cancelled
```

Avoid states such as:

``` text
isLoading
isConnected
isSending
isDone
```

all independently controlling the same workflow, because they can
produce impossible combinations.

## 20. Frontend Performance Rules

-   Avoid unnecessary React re-renders.
-   Keep transfer progress updates throttled.
-   Use memoized file cards.
-   Do not store large binary chunks in global state.
-   Keep File/Blob objects local to the transfer engine.
-   Use Web Workers for CPU-heavy hashing if necessary.
-   Lazy-load shop-only components.
-   Optimize QR rendering.
-   Avoid large icon libraries when only a few icons are needed.

## 21. Error UX

Errors should tell the user:

1.  What happened.
2.  Whether their file is safe.
3.  What to do next.

Example:

> **Transfer interrupted**\
> Your original file is still on your phone.\
> Check your connection and try again.

## 22. Empty States

Customer:

> No documents selected\
> Select a document to send to the shop.

Shop:

> Waiting for documents\
> Ask the customer to scan the QR code.

## 23. Design Tokens

Keep tokens centralized:

``` text
spacing-1
spacing-2
spacing-3
spacing-4
spacing-6
spacing-8

radius-sm
radius-md
radius-lg
radius-xl
radius-pill

shadow-sm
shadow-md

motion-fast
motion-normal
motion-slow
```

## 24. Frontend Definition of Done

-   [ ] Pixel-inspired Material 3 visual language.
-   [ ] Mobile-first customer experience.
-   [ ] Desktop-first shop dashboard.
-   [ ] QR session UI.
-   [ ] File picker.
-   [ ] File validation.
-   [ ] Transfer progress.
-   [ ] Success/error states.
-   [ ] Session expiry UI.
-   [ ] Responsive layout.
-   [ ] Keyboard accessibility.
-   [ ] Reduced-motion support.
-   [ ] Dark mode.
-   [ ] No neon/cyberpunk styling.
-   [ ] No unnecessary animations.
-   [ ] Performance budget monitored.
