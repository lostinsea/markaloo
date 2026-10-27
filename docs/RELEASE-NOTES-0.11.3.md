# Markaloo 0.11.3

## Edit Text formatting

- Typed bold, italic and inline code format inside the Edit Text input.
  Other Markdown stays as typed; this is not a full rich-text editor.
- Edit Text and table cells use one shared formatting core.
  Shared fixes reach both, while each keeps its own source rules.
- Caret placement, continued typing and native Undo/Redo are preserved.
  Applying popup edits is one document Undo step; disk Save stays separate.
- Untouched source, Markdown structure and captured selection boundaries
  remain protected.

## Intentional limits

- No underline, formatting buttons or shortcut enablement.
  Existing popup shortcut blocking remains.
- Table-specific pipe, paste and inline-code rules stay separate from
  Edit Text's raw-Markdown and newline rules.
- No general HTML promotion or performance improvement is claimed.

## Qualification and downloads

- Focused Edit Text, shared-core/table and document-editor checks passed
  on the reviewed source.
- Some regression checks remain red: nested-bottom scroll-wheel chaining,
  the paragraph-menu contract and note centering at 200% zoom.
  The wheel failure also occurs on the executed unchanged baseline.
  The notes failure cause is unknown; no complete old patch baseline is claimed.
  These failures are not counted as passes or release-gate waivers.
- Release builds require the existing hosted table/editor-scroll checks,
  all platform builds, strict built-ASAR checks and build attestations.
- Separate formal revert/mutation proofs are explicitly user-deferred for
  0.11.3 and were not run. Natural red/green tests are not those proofs.
  The unsafe mutation helper was not executed.
- Earlier broad test fixes resume only after verified 0.11.3 publication.
- Windows offers Setup and portable downloads; Linux offers AppImage and
  Debian packages; macOS offers a disk image.
- Windows and macOS builds remain unsigned. Build attestations verify origin,
  not operating-system code signatures. macOS updates remain manual.
