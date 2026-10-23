# Markaloo 0.10.0

## New

- Offline fenced-code highlighting for Rust, Go, PHP, Ruby, Swift, Kotlin,
  Dart, R, PowerShell, YAML, TOML and Markdown.
- Existing language aliases, plain-text fallback and code-copy behavior remain.
  No language detection or network access is needed.

## Fixes

- TOC and search navigation now cancel an older tab scroll restoration.
  Resizing the preview after a jump no longer returns to the old reading position.
- Normal tab scroll restoration is preserved.

## Performance tradeoff

- The added language coverage has a known first-open cost.
  A twenty-pair Windows check measured representative first-open observed p95
  at 203.1 ms, up from 151.8 ms.
- The 51.3 ms increase exceeds the 50 ms allowance. This release accepts that
  tradeoff; the performance gate has not passed and its budget is unchanged.

## Downloads and limits

- Windows: choose the Setup installer or the portable executable.
- Linux: AppImage and Debian packages are available.
- macOS: use the disk image and manual release downloads for updates.
- Windows and macOS builds are unsigned. SmartScreen or Gatekeeper may warn.
  macOS automatic updating is not supported by these unsigned builds.
- Runnable downloads have GitHub build attestations. These are not operating
  system code signatures.
- Live installation and upgrade were not tested for this release.
