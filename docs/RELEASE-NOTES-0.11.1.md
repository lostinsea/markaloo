# Markaloo 0.11.1

## Table editing fixes

- Ordinary cell typing no longer adds editor-created HTML wrappers to Markdown.
- Backtick inline code formats while you type and stays valid after Update
  and reopening the table.
- Right-click Edit table uses the clicked table without requiring a selection.
  Edit selected rows still requires a meaningful selection.
- Cell edits preserve authored formatting, untouched source and cell Undo/Redo.
  Update remains one document Undo step; Save stays separate.
- Paste wholly inside Markdown-owned inline code immediately replaces each
  line break with one space. Ordinary cell paste and authored HTML code keep
  their line breaks.

## Intentional limits

- Ctrl/Command+B, I and U are blocked only in editable table-popup cells, with
  a message. Document-editor and app-wide shortcuts are unchanged.
- Only literal emoji-name and backslash-before-pipe code cases may generate
  `<code>` HTML to preserve their text. Ordinary code stays Markdown.
  Generic span wrappers and general HTML promotion are not allowed.

## Qualification and downloads

- Focused table and document-editor checks passed on the reviewed fix source.
  The release workflow also requires its focused checks, platform builds,
  strict built-ASAR checks and build attestations before publication.
- Full ordinary tests and performance remain unqualified. No performance gain
  is claimed. New formal revert records and individual mutation proofs are
  user-deferred for this release; natural red/green runs are not those proofs.
- Windows offers Setup and portable downloads; Linux offers AppImage and
  Debian packages; macOS offers a disk image.
- Windows and macOS builds remain unsigned. Build attestations verify origin,
  not operating-system code signatures. macOS updates remain manual.
