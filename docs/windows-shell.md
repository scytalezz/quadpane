# Windows shell integration

Current version: **0.5.0** (Windows x64 portable). Updated 2026-09-23. This replaces the old HTML desktop context menu and Alt-only Electron drag path. See the [Korean release notes](releases/v0.5.0.md).

## Behavior

- Right-click a file, folder, same-parent selection or folder background to open the real **classic Explorer menu**. Installed shell extensions supply their own commands and submenus. Windows 11's compact menu is not used. Shift-right-click requests extended verbs; Shift+F10 and the menu key use the focused selection.
- Rename returns to Quadpane's existing single-item rename dialog and reference-remapping logic. Windows view-specific verbs that require a full Explorer `IShellView` host are not implemented. Use Quadpane's sort/view controls and Ctrl+Shift+N when a background extension requires an Explorer view.
- Plain dragging starts Windows OLE drag with a shell `IDataObject` containing real file/folder paths. Alt is unnecessary. Ctrl requests copy; Shift requests move where the target supports it. Browsers decide which files/folders their upload zones accept.
- Tracked Quadpane-to-Quadpane drags retain same-drive move / other-drive copy and Ctrl/Shift overrides. The existing transfer service skips conflicts and reports partial failures.
- **External incoming drops copy, even with Shift.** Chromium acknowledges HTML drops before asynchronous file operations finish; reporting MOVE could make an external source delete files before a failed transfer. Use Cut/Paste for an external move into Quadpane.
- **Outgoing moves support targets that perform the complete move themselves**, including Explorer's optimized filesystem moves. The helper never deletes sources after `DoDragDrop`. Conventional targets that copy and ask the source to delete are not supported as full moves: originals remain, and explicit nonoptimized MOVE feedback produces a notice. Browser uploads retain originals. No generic post-drop deletion is performed.
- Ctrl+C/X/V and shell-menu Copy/Cut use the Windows file clipboard. Paste takes paths and preferred effect from one OLE object, checks its sequence, and uses Quadpane's transfer service. Completed cuts report optimized-move feedback and remove completed paths only while the original clipboard sequence still matches under the clipboard lock; failed items remain. Newer clipboard contents are preserved.
- Shell commands and external drop targets follow Windows/extension behavior, including their overwrite/delete prompts. Quadpane's no-overwrite and recycle-only guarantees apply to its built-in actions, not arbitrary shell commands.

## Implementation and lifecycle

### v0.5.0 request collision and error reporting fixes

The focus-triggered clipboard read can overlap with a context-menu or native-drag request. Clipboard reads, writes and paste completions now run FIFO; one menu or drag may reserve a place after that work, including its asynchronous validation. Once that UI request is reserved or active, further shell requests fail promptly with `SHELL_BUSY`. They are not queued behind the native UI loop, which could otherwise wait for the renderer to finish an in-app drop and deadlock. This does not make simultaneous menus or drags supported.

Cancellation, helper exit, pipe/protocol errors and startup failure reject active and queued requests; later requests can start a fresh helper. Events from a retired worker cannot settle requests belonging to its replacement. Shell IPC errors now retain their original codes and diagnostic details and use operation-specific Korean messages, with `SHELL_FAILED` for uncoded failures. A menu/drag/clipboard collision or helper failure is no longer misreported as a folder-read `READ_FAILED` error.

### Native helper

`desktop/native/ShellMenu.cs` is compiled as x64 with the Windows .NET Framework 4.x C# compiler. It runs out of process on an OLE-initialized STA with a Windows Forms message loop. A prewarmed persistent worker avoids compiler/process startup during gestures and preserves shell clipboard objects and modeless dialogs.

Selections use `SHCreateShellItemArrayFromIDLists` and `BHID_SFUIObject` (`GetUIObjectOf`) to obtain `IContextMenu`; backgrounds use `BHID_SFViewObject` (`CreateViewObject`). The host calls `QueryContextMenu`, `TrackPopupMenuEx`, canonical `GetCommandString` and `InvokeCommand`, forwarding `IContextMenu2/3` menu messages and `LRESULT`. Paths cross a JSON pipe, never a shell command line. Main-process IPC validates the sender/frame/URL and selection.

The transparent menu owner remains alive for outstanding property sheets. After a menu it restores the app foreground only if the helper still holds foreground; it does not take focus from a launched app or property sheet. DPI coordinates are converted from renderer CSS pixels through Electron DIP coordinates to physical screen pixels.

Close cancels a pending helper request instead of waiting forever for a hung extension. Returning focus to Quadpane and pressing Escape also cancels its active shell menu; the next request starts a fresh helper. Built-in file transfers still finish before exit. Cancelling the helper cannot undo an already dispatched shell action. Normal shutdown attempts clipboard flushing and graceful EOF, with a bounded forced-exit fallback.

`npm run build:native` compiles the helper. `npm run desktop` and `npm run build:portable` build it automatically. electron-builder places the EXE at `resources/native/Quadpane.Shell.exe` outside ASAR. Runtime requires Windows x64 and .NET Framework 4.x (included with supported Windows 10/11 installations); no C# compiler is needed on the user's machine.

## Verification

### v0.5.0 results

- `npm run check`: 28 JavaScript files passed.
- Full `npm test`: 59 passed, 1 skipped, 0 failed.
- The local `0.5.0-fixed` build succeeded. Overlapping clipboard-read and menu IPC requests reproduced the collision in the actual packaged app; the corrected behavior was then verified in the packaged app.
- These results do not establish physical menu clicks, drag/drop gestures or clipboard round trips with Explorer. Those manual checks remain unverified.

### Verification scope

- `npm run check`: JavaScript syntax checks.
- `npm test`: existing filesystem tests plus real shell COM menu enumeration for files, folders, multi-selection and backgrounds; real shell `IDataObject` CF_HDROP extraction with Unicode paths and folders; malformed requests, worker cancellation/recovery, and optimized clipboard feedback contract (`Performed DropEffect = NONE`, then `Paste Succeeded = MOVE`). The native feedback test uses a test data object and does not touch the system clipboard.
- Queue regression tests use a fake worker to cover focus-read ordering, UI reservations, prompt busy errors, cancellation and worker recovery. Shell-error tests invoke main IPC handlers with stubs to check operation messages and preserved error details. These test automated contracts rather than physical UI interactions.
- `node scripts/verification/verify-explorer.cjs <playwright-node_modules>` delegates to `verify-native-shell.cjs`. It checks the packaged renderer's right-click/keyboard/background requests, multi-selection, toolbar recovery, shell Rename handoff, clipboard bridge, default native drag dispatch and disk-backed File drops through real transfer operations. Menu/drag/clipboard IPC are intercepted. It does not claim a real physical OLE drop or interactive shell-command test.
- Reports in `.checks/native-integration/` include ASAR/helper hashes; `.checks/shell-menu-tests/` contains native enumeration evidence. Historical `VERIFICATION.md` results predate this change and do not establish its behavior.

Remaining manual checks: Explorer copy/move on same and different volumes; browser file upload and supported folder upload; Ctrl/Shift and Escape during short gestures; third-party submenus; Open With; Properties followed by another menu; clipboard round trips with Explorer, partial-cut conflicts, and a new clipboard during paste; mixed-DPI/negative-coordinate monitors; slow/unavailable UNC shares and large selections. Physical UI interactions remain unverified.

### Historical pre-v0.5.0 result (retained reference)

The results below were recorded for the earlier 0.4.0 artifact, before the v0.5.0 queue/error fixes. They are not v0.5.0 test, build or release evidence.

- Syntax: 25 JavaScript files passed. Tests: 41 passed, 1 pre-existing cross-volume test skipped, 0 failed.
- Final packaged integration: `.checks/native-integration/run-1790141432003/result.json`, four groups passed, no renderer errors.
- ASAR SHA-256: `e952a8990e9dd424ab9d18e78b3c929d661a68effff773eb2ace9812a24941cf`.
- Packaged helper SHA-256: `138b7fea0259cb82abdb7a6186bca0489d9127117b042e1190bb13c90abadd04`.
- Final portable build succeeded: `dist-portable/quadpane-0.4.0-portable-x64.exe` (109,255,799 bytes). SHA-256: `b68d84ebc9a56c492c71ea99542fd76f1ea460ec94bb42d1b279b1ff5084997a`.
- Packaged renderer, main, preload and shell service bytes match source; the helper outside ASAR matches the compiled helper. electron-builder normalizes package metadata, which was checked separately.
- Independent static review accepted the final focus/clipboard fixes and bounded move behavior; it did not establish physical drag/drop or shell-dialog behavior.

## Official API references

- [Microsoft IContextMenu::QueryContextMenu](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-icontextmenu-querycontextmenu)
- [Microsoft IContextMenu::InvokeCommand](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-icontextmenu-invokecommand)
- [Microsoft IShellItemArray::BindToHandler](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishellitemarray-bindtohandler)
- [Microsoft IShellItem::BindToHandler](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishellitem-bindtohandler)
- [Microsoft shell transfer scenarios and optimized moves](https://learn.microsoft.com/en-us/windows/win32/shell/datascenarios)
- [Electron native file drag documentation](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop) — consulted; replaced with the OLE worker to retain Copy/Move choices.
