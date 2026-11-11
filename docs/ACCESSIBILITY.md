# Accessibility

This page records what has been checked, how to use the app from the keyboard, and what is still
missing. It covers the React frontend (`frontend/src`). Target: WCAG 2.1 AA.

## Automated checks

Run them with `npx vitest run` in `frontend/`. Nothing below needs a database or the Tauri shell.

### axe-core (`src/a11y.test.tsx`)

[axe-core](https://github.com/dequelabs/axe-core) runs on the whole document in jsdom. A test fails on
any violation with impact **serious** or **critical**. Covered screens:

| Screen | What is rendered |
|---|---|
| Launcher (Welcome) | connection list with a favourite, a group, a read-only production connection |
| Connection dialog | engine picker, then the PostgreSQL form |
| Workspace | top bar, connection rail, sidebar tree with objects, tab bar, query tab (Monaco is stubbed with a textarea), status bar |
| Settings | every section in the side navigation (General ... Updates), one axe run per section |
| Confirm dialog | `ask.confirm` (destructive) |
| Safety dialog | production confirmation with typed phrase and SQL preview |
| Command palette | open over the workspace |
| Arabic | launcher and workspace with `lang="ar" dir="rtl"` |

What axe found before this pass (serious/critical), all fixed:

- `nested-interactive`: a focusable **Connect** button inside each launcher `role=option`, and a
  **Close** button inside each `role=tab`. The visible icons are now mouse-only (`aria-hidden`); keyboard
  users press Enter (connect) or Delete (close tab), and both actions are also in the context menu.
- `aria-required-children`: the sidebar `role=tree` contained plain buttons instead of `treeitem`s, and
  the tab strip `role=tablist` contained the "+" button. The tree is now a real tree (below); the "+"
  button moved outside the tablist.
- `aria-required-attr`: the editor/results splitter (`role=separator`, focusable) had no
  `aria-valuenow`. Both splitters now expose value, min and max.
- `html-has-lang`: `<html lang>` is now set from the active language (it stayed `en` in Arabic before).

Remaining **moderate** finding: `region` for the sidebar resize handle, which sits between the sidebar
`<aside>` and `<main>`. Harmless; not fixed.

Limits of the axe run:

- jsdom has no layout or computed colours, so axe's `color-contrast` rule cannot run. Contrast is
  checked from the CSS tokens instead (next section).
- Views that need live data (table grid, structure, diff results, monitor, ER, import/backup) are not
  rendered by the axe test. Their strings and labels were reviewed by hand during the localisation
  pass, but there is no automated axe run on them yet.
- The Monaco editor is stubbed. Monaco has its own accessibility mode (Alt+F1 / Ctrl+F1 in the editor).

### Colour contrast (`src/lib/theme.test.ts`)

Computed from the RGB tokens in `src/index.css` for the light, dark and high-contrast themes:

- body text tokens (fg, muted, accent, danger, warn, ok, purple) on bg/panel/raised: >= 4.5:1
- white/black text on solid fills (primary and danger buttons, selected rows): >= 4.5:1
- tinted badges and alerts (`bg-x/15` with `text-x`, error box `bg-danger/10`): >= 4.5:1
- focus ring vs. every surface (WCAG 1.4.11 non-text contrast): >= 3:1
- muted text on hover rows: >= 4.5:1

This pass found and fixed: light-theme badges (ok/accent/warn/purple) at 4.0-4.4:1, the light error
box at 4.45:1, the dark accent badge at 4.2:1, dark muted-on-hover at 4.4:1, and a light focus ring
at 3.0:1 (drawn at 70% opacity; now solid). Tokens changed: light `--accent --danger --warn --ok
--purple`, dark `--accent --muted`. Button fills (`--accent-solid`, `--danger-solid`) are unchanged.

### Keyboard behaviour (`src/a11y.test.tsx`, "keyboard" suite)

Tested: tree arrow navigation and expand/collapse with a single Tab stop; tab bar arrows activate the
next tab and Delete closes it; dialogs keep focus inside and return it to the opener on Escape; context
menu opens with Shift+F10, arrows move between items, Escape closes; toasts render in a persistent
polite live region.

## Keyboard map

"Mod" is Cmd on macOS and Ctrl elsewhere. Global shortcuts can be rebound in Settings -> Keyboard
shortcuts.

### Global

| Keys | Action |
|---|---|
| Mod+Shift+P / Mod+P | Command palette (type, Up/Down, Enter; Escape closes) |
| Mod+K | Open database picker (type to filter, Up/Down, Enter or double-click opens; Escape closes) |
| Mod+T | New SQL query tab |
| Mod+W | Close tab |
| Mod+Shift+T | Reopen closed tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Mod+1 ... Mod+9 | Switch to open connection 1-9 |
| Mod+, | Settings |
| Mod+B | Toggle sidebar |
| Mod+Shift+N | New connection |
| Mod+Shift+F | Focus mode |

### Widgets

| Where | Keys |
|---|---|
| Launcher connection list | Up/Down/Home/End move through groups and connections, Left/Right collapse/expand a group or jump to its header (mirrored in Arabic), Enter connects (or toggles a group), Shift+F10 or the Menu key opens the context menu (edit, duplicate, favourite, move to group, delete; group: rename, colour, reorder, delete) |
| Schema rail (below the connection rail) | Tab in, Up/Down between opened databases/schemas, Enter/Space switches, Shift+F10 removes one |
| Connection rail | Tab or Up/Down between connections, Enter/Space switches, Shift+F10 opens the menu (new query, disconnect) |
| Sidebar object tree | Up/Down move, Right expands a group or enters it, Left collapses or goes to the parent (mirrored in Arabic), Home/End, Enter opens the object, Shift+F10 opens the object menu (generate SQL, DDL, copy name, drop...) |
| Sidebar width | Tab to the splitter, Left/Right resize (Shift for bigger steps) |
| Tab bar | Left/Right (mirrored in RTL), Home/End move and activate, Delete closes, Shift+F10 opens the tab menu (pin, duplicate, close others) |
| Menus | Up/Down/Home/End, Enter activates, Escape or Tab closes and returns focus |
| Dialogs | Focus starts in the first field; Tab/Shift+Tab cycle inside; Escape closes; focus returns to the control that opened it |
| SQL editor (Monaco) | Mod+Enter run selection/current, Mod+Shift+Enter run all, Mod+Alt+F format, Mod+. cancel; Alt+F1 Monaco accessibility help |
| Data grid | Arrows move, Mod+Arrow jumps to the edge, Shift+Arrow extends, PageUp/PageDown, Tab/Shift+Tab next/previous cell (leaves the grid at the first/last column), Enter or F2 edits, Shift+Delete sets NULL, Mod+C copies, Mod+A selects all |

## Other changes in this pass

- Toasts are in a persistent `role=log aria-live=polite` region; errors use `role=alert`.
- Query completion/failure is announced through a visually hidden `role=status` region.
- Spinners without visible text announce "Loading…".
- Icon-only buttons have translated `aria-label`s; decorative glyphs are `aria-hidden`.
- Settings navigation uses `aria-current="page"`; each section is a labelled `<section>`.
- Tabs are linked to their panels (`aria-controls` / `aria-labelledby`).
- The data grid no longer traps Tab.
- Right-to-left: `<html dir>` follows the language; layout uses logical Tailwind utilities
  (`ms-/me-/ps-/pe-/start-/end-/border-s/border-e/text-start`); the SQL editor, data grid and
  SQL/JSON blocks are pinned to LTR.

## Known gaps

- **No screen-reader testing has been done.** Everything above is automated (axe in jsdom plus unit
  tests). Nobody has used the app with VoiceOver, NVDA or Orca yet.
- Colour contrast is verified from tokens, not from rendered pixels. Text drawn with extra opacity
  (for example `disabled:opacity-45` buttons, placeholder text) is not covered; disabled controls are
  exempt from WCAG contrast, but placeholders are not.
- Plugin-provided text (plugin names, descriptions, setting labels, export labels) and backend error
  messages are shown as delivered, usually in English.
- Views that need a live database have no automated axe run (see above).
- Drag-and-drop tab reordering has no keyboard equivalent yet (moving a connection between groups does: context menu → Move to group).
- Launcher group headers are focusable `role=group` elements with `aria-expanded` (a button is not allowed inside a listbox); screen readers may announce them as "group" rather than as a disclosure button.
- The ER diagram is an SVG canvas without a text alternative; use the Structure view instead.
- Context menus open at the mouse position or under the focused element; they do not reposition
  themselves when they would overflow the window bottom.
- Monaco and the data grid stay left-to-right in Arabic on purpose (SQL and data are LTR).

## Manual check for you: VoiceOver (macOS)

Not performed by the developer of this pass. Please run it on a real build and note the results here.

1. Build and start the app (`npm run tauri dev` in `frontend/`, or an installed build).
2. Turn on VoiceOver: Cmd+F5. Open the VoiceOver Utility and check that "Web" navigation is on.
3. **Launcher.** Press Tab until the connection list is reached. Expect: "Connections, list box", then
   each connection read as name, engine/host and environment ("Local", "Production"). Up/Down should
   move and read each one. Press Shift+F10: a menu should be announced with "Connect, Edit, ...".
   Escape should return to the same connection.
4. **New connection.** Activate "Create a new connection". Expect the dialog title to be read and
   focus to land in the dialog. Tab through every field: each must read a label (not just "edit text").
   Press Escape: focus must return to the "Create a new connection" button.
5. **Connect** to a test database. Expect the toast/status to be announced.
6. **Sidebar tree.** Tab into the object tree. Expect "Objects, tree", then "Tables, N items, expanded,
   level 1". Down arrow: table names, "level 2". Left: back to the group. Left again: "collapsed".
7. **Tab bar.** Press Mod+T twice, then Tab to the tab strip. Expect "Query, tab, 1 of 3, selected".
   Right arrow should move and select. Delete should close the tab.
8. **Query.** In the editor run `select 1` with Cmd+Enter. Expect a completion message ("Completed in
   N ms") to be read without moving focus. Run an invalid statement: an error should be announced.
9. **Safety dialog.** On a connection marked Production, run `delete from t where false`. Expect the
   dialog title, the finding ("destructive", statement number) and the typed-confirmation field label.
10. **Settings → Language → العربية.** The layout should mirror; VoiceOver should switch to an Arabic
    voice for UI text. Repeat steps 6-7: arrow keys in the tree and tab bar are mirrored (Left = into /
    next).
11. Record anything not announced, announced twice, or announced in the wrong language.

On Windows, repeat with NVDA (Insert+Space toggles browse/focus mode; use focus mode in the tree and
grid).
