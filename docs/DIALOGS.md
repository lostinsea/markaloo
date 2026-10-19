# App dialogs

## Shared presentation

- `app-dialogs.js` draws message and confirmation cards using the app's CSS,
  fonts, selected palette and button styles.
- Text, filenames and error details use text nodes, never HTML.
- Cards keep private references to app-owned controls. Document HTML cannot
  replace them by using the same IDs.
- Screen-reader labels and explanations reference those controls directly,
  so document IDs cannot replace the warning that is announced.
- Cancel is the default for decisions. Escape, the close button and backdrop
  clicks do not authorize an action.
- Native HTML dialogs contain keyboard focus. App shortcuts cannot run behind
  them. Focus returns only to a visible control, not a dismissed toast.
- Cards scroll within the window. Action buttons remain reachable at narrow
  widths and high zoom. Existing themed input editors use the same bounds.
- Questions are queued. Each answer belongs to its own question.
- Outcomes distinguish an explicit choice from cancellation, stale state,
  abort, navigation and a Main-owned modal taking over.
- Presentation failures are errors, not approval or acknowledgement.

## Coverage inventory

| Entry points | Surface and owner | Safety kept |
|---|---|---|
| Toolbar Open; history Back/Forward; recent file; external file-open request | Shared card in the document window | Genuine unsaved-edit confirmation; document, selection and pending-save checks after the answer |
| Toolbar Refresh; Ctrl+R; File Updated Reload | Shared card in the document window | Genuine unsaved-edit confirmation remains separate from protected disk adoption |
| Leave edit mode | Shared card in the document window | Cancel keeps the editor and its changes; stale consent cannot discard newer text |
| Close tab; deletion discovered during close | Shared card in the document window | Exact tab and dirty state; authoritative deletion revision; Main retires only acknowledged evidence |
| Protected disk adoption | Retained Main transaction; shared card in the document window | Cause-specific reload wording; original owner, evidence, path, approved version and sibling checks repeated after the answer |
| Retire an earlier deletion episode | Retained Main transaction; distinct shared card | Keep protection is the default; this action does not reload or replace the current document |
| Open an expensive document; activate an expensive tab | Dedicated Main-owned themed window | Cancel by default; open request, window, permission and disk snapshot rechecked before delivery; tab context rechecked before rendering |
| Open an external local file from a trusted link | Dedicated Main-owned themed window | Original private gesture and document binding; exact destination and file type rechecked after the answer |
| Close window; quit; update installation's existing shutdown questions | Dedicated Main-owned themed window | Existing save/discard/cancel mappings, shutdown record, revision, commit and freeze checks |
| Saving blocked; document tracking stopped | Dedicated Main-owned themed window | Refusal does not depend on showing or dismissing the notice |
| Save request/result errors; PDF request/result errors | Shared acknowledgement card | Error stays visible without delaying save-result acknowledgement or changing document state |
| Image, Mermaid and table popouts | Existing child windows with canonical app palette and bundled fonts | Existing popup preload, CSP, navigation and export safeguards |
| Note, Find Note, text, Mermaid and table input editors | Existing themed editors | Existing editing actions retained; responsive scrolling, font and preview-color alignment |
| File Updated, updater and ordinary notifications | Existing themed toasts | Existing notification and update behavior retained |

## Authority and lifecycle

- The shared browser helper presents choices. It grants no filesystem access
  and cannot clear Main's document or deletion evidence.
- Protected adoption and historical retirement use Main-retained, one-use
  transactions. Answers cannot renew the original deadline.
- Main initiates its own isolated dialog windows. Their preload can read one
  presentation and answer that presentation only.
- Main checks the exact child, frame, nonce, button and lifecycle state.
  Navigation, destruction, abort and expired requests cancel safely.
- Losing the document renderer cancels document-bound questions. Independent
  questions remain only while Main's authority is still current.
- Main serializes presentations per owner window. Other windows have their own
  queues. Root-window busy notifications coordinate focus; they are not
  authorization.
- While Main owns a modal, conflicting local decisions cancel and informational
  acknowledgements wait instead of overlapping.
- Theme publication carries only a validated palette preference. PDF export's
  temporary light appearance does not change that preference.
- The document renderer can fail without taking the independent themed
  shutdown question with it.
- Handing a pathname to another application is not atomic. Rechecking the
  destination does not remove that operating-system limit.

## Intentional native surfaces

- Open/Save file and directory pickers remain native.
- Operating-system permission, authentication and security warnings remain
  native. Nothing bypasses those warnings.
- Installer UI and Electron/platform startup failures stay with their owner.
- Native message boxes are an emergency fallback only when the independent
  themed host itself cannot show:
  - an explicit shutdown/fallback decision; or
  - a terminal saving-blocked or tracking-stopped notice.
- A broken document renderer alone does not trigger that fallback.
- Ordinary large-file, external-file and historical approvals fail closed if
  presentation fails. They do not open a second native approval question.

## Regression commands

- `npm run test:reload-dialog`: protected reload through the production preload.
- `npm run test:owned-dialogs`: isolated Main dialog host and authority contracts.
- `npm run test:dialogs`: production document-window actions and shared queues.
- `npm run test:theme`: canonical theme coverage.
- `npm run test:packaging`: source references and shipped assets.
- Use the revert harness's exact record IDs to prove sensitivity. An anchor
  check alone is not a behavioral proof.
