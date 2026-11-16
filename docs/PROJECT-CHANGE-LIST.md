# Project change list

- Customer-facing changes added by Markaloo, including security and performance.
- **0.13.0 is published. 0.14.0 is upcoming and not yet released.**
- Existing tabs, notes, split editing, basic themes, search, Mermaid, table
  popouts and PDF export are not new features.

## Recent releases

| ID | Release | Changes |
|---|---|---|
| V014-01 | 0.14.0 - upcoming | Move columns left/right and data rows up/down in Edit/Insert Table using a separate Move group. The header stays the header. |
| V014-02 | 0.14.0 - upcoming | Resize Edit/Insert Table from either vertical edge or the lower-right corner. |
| V014-03 | 0.14.0 - upcoming | Edit/Insert Table opens wider for readability while staying within the available window. |
| V014-04 | 0.14.0 - upcoming | Table cells support syntax colors for explicitly labelled code in existing supported languages and aliases. Ordinary backtick inline code stays plain; there is no language guessing. |
| V014-05 | 0.14.0 - upcoming | Optional **Word wrap** beside page size in the separate filtered table viewer. It starts off. |
| V014-06 | 0.14.0 - upcoming | Keep the search panel above sticky table headers. |
| V014-07 | 0.14.0 - upcoming | Closing search releases its keyboard focus so hidden search no longer receives typing. |
| V013-01 | 0.13.0 - published | Back/Forward buttons revisit up to ten reading locations per tab from heading, internal-link and search jumps. Windows Alt+Left/Right also navigate reading history. |
| V013-02 | 0.13.0 - published | Improve reading-position handling across Edit/Split changes, tabs and zoom. Newer navigation takes priority over delayed position updates. |
| V013-03 | 0.13.0 - published | Improve linked scrolling when the user reaches the end of a nested scroll area. |
| V013-04 | 0.13.0 - published | Schedule daily update checks with at most one automatic reminder per local day. Downloads and installation remain explicit actions. |
| V013-05 | 0.13.0 - published | Expand **See what is new** in the update notice to load that version's release notes on demand, without opening their links or loading their images. |
| V013-06 | 0.13.0 - published | Packaged Windows builds import settings and saved sessions from the default Folia profile when no Markaloo profile exists. Unsaved editor text is not recovered. |
| V012-01 | 0.12.0 - published | Resize table columns in the reading view and table-editing grid. |
| V012-02 | 0.12.0 - published | Create tables, edit whole tables or selected rows in one grid. Insert rows above/below and columns left/right; confirm row or column removal. |
| V012-03 | 0.12.0 - published | Keep table updates and document Undo/Redo separate from typing history inside cells. |
| V012-04 | 0.12.0 - published | Improve table-dialog sizing, compact action icons with tooltips and context-menu behavior during unrelated scrolling. |
| V012-05 | 0.12.0 - published | Let wide Mermaid diagrams use space beyond the reading column and keep sequence labels readable. |

- In 0.14.0, labelled table-cell code uses HTML such as
  `<code class="language-rust">let count = 1;</code>`.
  Literal code punctuation may need HTML entities, such as `&lt;` for `<`.
- Table widths are view-only, not saved in Markdown. Reading-view widths reset
  when the document renders again; table-editing widths reset on reopening.
  Persistent widths, hidden metadata and automatic saving are not included in 0.14.0.
- Reading history is temporary and separate from document Undo and file history.
  Ordinary scrolling does not add stops. On Windows, use the toolbar buttons
  for navigation from embedded HTML panels.

## Earlier changes: documents and editing

### Tabs, refresh and file safety

- Refreshing one tab no longer restores stale text in another.
- Save and reload results update the original tab, even after switching tabs.
  Newer typing remains unsaved; dirty tabs are not silently replaced.
- Restore the selected document after restart without rendering every tab first.
- Keep reading position through refresh while images and diagrams settle.
  Keep the File Updated notice until the reader acts.
- Keep standalone Mermaid files and files with a byte-order mark consistent
  across opening, restoring and refreshing.
- Protect unsaved work during close, quit and update installation, including
  pending or failed saves. Cancel keeps the editor and its changes.
- Recheck file identity and disk changes before replacing content.
  Reload questions distinguish a returning file from a replacement at the same path.
- Preserve original line endings when the text has not otherwise changed.
- Known limit: an external edit can escape detection if it keeps the same file
  size and restores the original modification time.

### Document and table editors

- Each tab keeps its own editor draft, selection, Undo/Redo and scroll position.
  Opening an already-open editor does not reset it. Save and Exit stay separate.
- Closing a tab clears its editor session. Drafts and Undo history are not
  restored after restarting the app.
- Document-changing context-menu actions require edit mode.
  Notes remain available in reading mode and save on confirmation.
- Edit rendered table cells without a separate Markdown box. Preserve surrounding
  text, unselected rows and unchanged formatting.
- Apply a table Update as one document Undo step without saving the file.
  Cancel leaves the document unchanged.
- Create tables with an editable header, including header-only tables.
  The header cannot be removed, and at least one column must remain.
- Select a cell before inserting or removing rows or columns.
  Selected-row editing cannot change the whole table's columns.
- Move between cells with Tab or Enter/Shift+Enter.
  Ctrl+Enter applies the update; Escape cancels.
- Type backtick code, `**bold**` and `*italic*` inside cells or Edit Text.
  Native typing Undo/Redo stays inside that editor.
- Refuse ambiguous, unsupported or stale table selections instead of changing
  unrelated text. Raw HTML tables, nested tables and ragged rows are not supported
  by the table-editing grid.
- Resize insertion dialogs within the available window. Grid columns fit the
  dialog and scroll when they cannot shrink further; image thumbnails keep
  their proportions.

## Earlier changes: reading and rendering

### Navigation, search and scrolling

- Use a single toolbar with tab tooltips, Copy Path and Open Folder actions.
  Open documents by drag and drop.
- Keep menus and search controls reachable in narrow or short windows.
- Show the table of contents on the left, track headings through H1-H6 and
  keep the current heading visible without taking document focus.
- Remember the choice of table of contents, All Notes or a closed drawer.
  Preserve reading position when drawers open or close.
- Raise document zoom to 400% and remember the reading percentage across
  documents, reader windows and restarts.
- Keep folded sections separate between documents and preserve folding on rerender.
- Refresh search results after edits and finish pending search before moving
  between matches.
- Link Source and preview scrolling by matching content rather than equal
  scroll percentages. Wheel, scrollbar and keyboard input choose the leading pane.
- Keep source text, selection and Undo unchanged during scrolling.
  Complex or collapsed content can align to a section boundary instead of a line.
- Fix an empty-list scrolling problem that could freeze the app.

### Tables, images, diagrams and appearance

- Size table columns to their content. Wide tables can extend beyond the prose
  column; narrow views wrap suitable cells or scroll horizontally.
- Keep table headers visible while scrolling, including independent nested tables.
- Wrap long links and inline code in cells without changing preformatted blocks.
  Keep long ordered-list markers visible.
- Resolve relative image paths from the document location, including spaces,
  hashes and parent directories.
- Keep literal placeholder text and `$` sequences from corrupting rendered
  blocks or file messages.
- Improve Mermaid label proportions, zoomed rendering, dark-theme contrast and
  first-open appearance. An invalid diagram no longer prevents valid neighbors
  from rendering.
- Remove blurry image and diagram popout rendering.
- Add Clarity, Parchment, Abyss and Ember color schemes, with a remembered scheme
  for light and dark modes. Apply colors to code, notes, dialogs and errors.
- Keep PDF output printer-friendly and restore the reading appearance afterward.
- Use compact popup controls for diagram PDF, image PNG/JPG and table CSV/JSON
  exports. Ctrl/Cmd+wheel over inline Mermaid follows document zoom.
- Known limits: oversized diagrams still shrink to fit; automatic Mermaid
  sequence-label wrapping is not included. Dense table cells can split words
  and numbers in narrow views without adding line breaks to Markdown.

### Offline code languages

- Add bundled syntax highlighting for Rust, Go, PHP, Ruby, Swift, Kotlin,
  Dart, R, PowerShell, YAML, TOML and Markdown.
- Keep existing languages, aliases and exact source-copy behavior.
- Unknown or unlabelled code blocks stay plain. No language detection or
  runtime language downloads.
- Editor text and ordinary inline code stay plain. The upcoming 0.14.0
  table-cell option requires an explicit supported language label.

### Dialogs, updates and installation

- Use the selected palette and bundled font in app messages and confirmations.
  Keep keyboard focus inside decisions, with Cancel as the safe default.
- Keep native file pickers and operating-system warnings.
- Show the running version and update status in About, with explicit Check,
  Download and Restart & install actions.
- Remember a known newer version while offline. Opening About does not itself
  contact the update service.
- Ordinary quit does not install a downloaded update. Keep unsaved-document
  protection when installing updates.
- Use Markaloo's own release feed and preserve custom installation directories.
- Windows and macOS downloads are unsigned and may trigger operating-system
  warnings. Unsigned macOS builds use manual release downloads.

## Security and privacy

- Bundle rendering libraries and fonts locally instead of loading them from CDNs.
- Sanitize rendered content, including tables, and display document-controlled
  names and messages as text rather than executable HTML.
- Isolate explicit HTML in sandboxed frames. Block forms, document-triggered
  downloads, remote frames and unsafe stylesheet resource links.
- Prevent documents from replacing the app window or opening arbitrary app windows.
- Block local links to executables, scripts and macros. Reject remote shares
  before accessing them; ask before opening uncertain external file types.
- Limit what document and popup content can ask the app to do, including file
  actions on the relevant open document.
- Restrict popup actions and exports, and use private temporary files so
  concurrent popups do not overwrite each other's output.
- Remove document translation and its outbound document-content requests.
  Diagnostic file logging is opt-in.
- Disable developer-tools shortcuts in installed builds unless explicitly
  enabled for diagnostics.
- Authored HTTPS images and update checks can still contact the network.
  Bundled rendering does not mean all network access is disabled.

## Performance

- Load Mermaid only when a diagram needs it, reducing startup work for documents
  without diagrams.
- Reuse unchanged diagrams, images and code blocks after edits instead of
  rebuilding and highlighting everything.
- Improve large-table parsing and batch table layout work.
- Reduce repeated work during search, zoom, Mermaid theme changes and scrolling.
- Reduce repeated document scans when checking for unsaved changes.
- Warn before unusually expensive document opens or tab switches.
  Very large or complex documents can still be slow.

## Removed features

- Remove organization-specific document modes, the bundled VS Code extension,
  image slider, document translation, interface localization and Word export.

## More information

- [Published releases](https://github.com/lostinsea/markaloo/releases)
- [0.13.0](https://github.com/lostinsea/markaloo/releases/tag/v0.13.0)
  and [0.12.0](https://github.com/lostinsea/markaloo/releases/tag/v0.12.0)
- [Security details](https://github.com/lostinsea/markaloo/blob/main/docs/SECURITY-AUDIT.md)
- [Performance details](https://github.com/lostinsea/markaloo/blob/main/docs/PERF-AUDIT.md)
