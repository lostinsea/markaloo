# Markaloo 0.11.0

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
- Search stays below the toolbar and beside the open table of contents.
  Search controls wrap to fit narrow windows.

## Qualification and known limits

- The focused table run passed 47 source checks and 245 UI checks. All eight
  captures were viewed. This evidence carries to the unchanged product bytes;
  it is not a new run of every test on the release-preparation commit.
- The full ordinary test suite has not passed for 0.11.0. The user chose to
  release the current product and defer test repairs, and any resulting product
  fixes, to 0.11.1. Deferred or failed checks are not recorded as passing.
- Combined-candidate performance has not been measured. Some long input delays
  remain; no general speedup or smooth-typing guarantee is claimed.
- Build and artifact checks are required before publishing. Live installation
  and upgrade have not been tested.

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
