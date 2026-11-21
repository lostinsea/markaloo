# Markaloo 0.14.9

## Fixes

- Insert Table now uses the right-clicked blank line between closed code blocks,
  between paragraphs, or at the end of the document. Undo removes just the
  table insertion, and Cancel returns the cursor to where it was.
- Back and Forward now work after the first jump within a restored tab,
  whether you use a link in the document or the table of contents.
