# Markaloo 0.10.1

## Improvements

- Small source edits keep unchanged parts of the hidden scroll-measurement
  mirror attached instead of rebuilding every span.
- Source offsets and wrapping measurements are refreshed for the current text
  and layout. Unicode boundaries and the end-of-document marker are preserved.
- In three matched Windows trials on one 1 MiB prose document, the complete
  edited-geometry build fell from 346-365 ms to 251-258 ms, a 26-31% reduction
  for that operation. The current preview and scroll mapping were ready
  95-121 ms earlier.
- These are local workload results, not a general speedup or smooth-typing
  guarantee. Some long input delays remain.

## Unchanged

- Preview refresh still waits for a 400 ms typing pause.
- No dependency upgrades, table-editing features or rendering redesign.
- The original 0.10.0 language-highlighting first-open performance exception
  remains limited to that feature. Its failed gate and budgets are unchanged.

## Downloads and limits

- Windows: choose the Setup installer or the portable executable.
- Linux: AppImage and Debian packages are available.
- macOS: use the disk image and manual release downloads for updates.
- Windows and macOS builds are unsigned. SmartScreen or Gatekeeper may warn.
  macOS automatic updating is not supported by these unsigned builds.
- Runnable downloads have GitHub build attestations, not operating-system
  code signatures.
- Live installation and upgrade were not tested for this release.
