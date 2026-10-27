# Markaloo 0.11.2

## Table editing fixes

- Typing `**bold**` or `*italic*` formats the cell immediately.
  Formatting stays correct after Update and reopening the table.
- Typing can continue outside completed formatting. Existing formatting,
  images, untouched source and cell Undo/Redo are preserved.
- Existing inline-code, paste and source-preservation rules are unchanged.
  Update remains one document Undo step; Save stays separate.

## Intentional limits

- Underline, formatting buttons and shortcut enablement are not included.
- Ctrl/Command+B, I and U remain blocked only in editable table-popup cells,
  with a message. Document-editor and app-wide shortcuts are unchanged.
- Ordinary content stays Markdown; authored HTML stays distinct.
  Only the existing narrow literal emoji-name and backslash-before-pipe code
  cases may generate `<code>` HTML. Generic span wrappers are not allowed.

## Qualification and downloads

- Focused table and document-editor checks passed on the reviewed fix source.
  Release builds also require focused Windows table/editor-scroll checks,
  all platform builds, strict built-ASAR checks and build attestations.
- Separate formal revert/mutation proofs are explicitly user-deferred for
  0.11.2 and were not run. Natural red/green tests are not those proofs.
  The unsafe mutation helper was not executed.
- Broader ordinary testing resumes after verified publication.
  Performance remains unqualified; no performance gain is claimed.
- Windows offers Setup and portable downloads; Linux offers AppImage and
  Debian packages; macOS offers a disk image.
- Windows and macOS builds remain unsigned. Build attestations verify origin,
  not operating-system code signatures. macOS updates remain manual.
