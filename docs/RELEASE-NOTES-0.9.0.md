# Markaloo 0.9.0

## What's new

- **About and updates:** File -> About Markaloo shows the running version and
  shared update status. Check, download and install are explicit actions.
  A known newer version stays visible after an offline restart.
- **TOC defaults:** the first document opens with its table of contents when
  no preference exists. Your saved TOC, Notes or closed-panel choice still wins.
- **Document-owned editors:** each tab keeps its own draft, selection, undo
  history and scroll position. Repeated Open editor does not reset anything.
  Save and Exit remain separate actions.
- **Content-aware scrolling:** source and preview follow matching content in
  both directions, including after pane, TOC and zoom changes. Some collapsed
  or complex HTML sections align to the start of their section.
- **Grouped toolbar:** Reload and Open editor are document actions; the separate
  TOC toggle works across tabs and on Welcome. Reload and Edit are disabled
  when no document is loaded. An empty document is still editable.
- **Reliability:** fixes an empty-list Markdown freeze and avoids unnecessary
  startup and render work.

## Downloads and limits

- Windows: choose the Setup installer or the portable executable.
- Linux: AppImage and Debian packages are available.
- macOS: use the disk image and manual release downloads for updates.
- Windows and macOS builds are unsigned. SmartScreen or Gatekeeper may warn.
  macOS automatic updating is not supported by these unsigned builds.
- Runnable downloads have GitHub build attestations. These are not operating
  system code signatures.
- Live installation and upgrade were not tested for this release.
