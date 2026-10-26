# Markaloo 0.11.0 test candidate

- Provisional source for testing, not a published or qualified release.

## Visual table editing

- In edit mode, select one table or some rows in either pane.
- Right-click Edit table for the whole table, or Edit selected rows for a subset.
- Edit formatted cells in a resizable grid without a Markdown source pane.
- Update the document applies one undoable change. Save remains separate.
- Cancel leaves the document unchanged. Unsafe or stale selections show an error.

## Improvements

- Small source edits keep unchanged parts of the hidden scroll-measurement
  mirror attached instead of rebuilding every span.
- Source offsets and wrapping measurements are refreshed for the current text
  and layout. Unicode boundaries and the end-of-document marker are preserved.
- Combined-candidate performance has not been measured. Some long input delays
  remain; no general speedup or smooth-typing guarantee is claimed.

## Unchanged

- Preview refresh still waits for a 400 ms typing pause.
- No dependency upgrades or rendering redesign.
- The original 0.10.0 language-highlighting first-open performance exception
  remains limited to that feature. Its failed gate and budgets are unchanged.

## Downloads and limits

- Windows: choose the Setup installer or the portable executable.
- Linux targets: AppImage and Debian packages.
- macOS: use the disk image and manual release downloads for updates.
- Windows and macOS builds are unsigned. SmartScreen or Gatekeeper may warn.
  macOS automatic updating is not supported by these unsigned builds.
- Runnable downloads have GitHub build attestations, not operating-system
  code signatures.
- Candidate builds, live installation and upgrade have not been tested.
