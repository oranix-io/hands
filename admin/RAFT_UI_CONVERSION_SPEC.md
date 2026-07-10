# raft-ui elegant conversion spec (task #129)

Convert raw HTML form controls in admin pages to raft-ui components so the
"elegant" theme (already applied via `<ThemeProvider theme="elegant">` in
main.tsx) is visible. **Preserve ALL logic, handlers, state, keys, and residual
utility classes exactly.** Only swap the element and map the class → variant.

## Import
Add/extend at top of the file:
```ts
import { Button, Input } from "raft-ui";
```
(Only import what the file actually uses. If Switch/Badge already imported, keep.)

## Buttons: `<button>` → `<Button>`
- `className="btn-primary"`   → `<Button variant="primary">`
- `className="btn-secondary"` → `<Button variant="outline">`
- `className="btn-danger"`    → `<Button variant="danger">`
- Residual utility classes stay in `className`. Examples:
  - `className="btn-secondary text-xs"` → `<Button variant="outline" className="text-xs">`
  - `className="btn-primary w-full mt-4"` → `<Button variant="primary" className="w-full mt-4">`
  - `className="btn-secondary py-1! px-2! text-xs! whitespace-nowrap"` →
    `<Button variant="outline" className="py-1! px-2! text-xs! whitespace-nowrap">`
- Keep `type`, `onClick`, `disabled`, `title`, `aria-*`, `key`, etc. unchanged.
- If a button has a `disabled={x.isPending}` that represents a pending action,
  you MAY optionally use `loading={x.isPending}` instead of a text spinner, but
  do NOT change behavior otherwise. When in doubt, keep `disabled` as-is.
- Anchor styled as a button: `<a className="btn-primary" href=...>Text</a>` →
  `<Button variant="primary" render={<a href=... />}>Text</Button>`
  (move `href`, `target`, `rel`, `download` onto the inner `<a>`; keep children
  as Button children). Drop any `no-underline` residual (Button handles it).
- Plain unstyled `<button>` (no btn-* class, e.g. icon-only close buttons):
  use `<Button variant="ghost" size="sm" className="...residual...">`. If it's a
  bare icon toggle where ghost looks wrong, leave it as a native `<button>` —
  use judgment, don't force it.

## Text inputs: `<input ...>` → `<Input ...>`
- Only for text-like inputs: `type="text"|"email"|"url"|"number"|"password"|
  "search"` or no type. Map `className="input"` → drop it (Input is prestyled);
  keep residual classes in `className`.
- Keep `value`, `onChange`, `placeholder`, `type`, `disabled`, `required`,
  `min`, `max`, `step`, `autoFocus`, `ref`, `name`, etc.
- **DO NOT convert** `type="file"`, `type="checkbox"`, `type="radio"`,
  `type="range"`, or hidden inputs — leave those as native `<input>`.

## LEAVE ALONE (do not touch in this pass)
- `<select>` elements (compositional Select is a separate pass)
- checkboxes, radios, file inputs, range inputs
- `<textarea>`
- Any element without a clear mapping — leave native rather than guess.

## After editing
Do not run a build (the coordinator runs one central `tsc` + build). Just make
the edits cleanly and report: file, # buttons converted, # inputs converted, and
anything you intentionally left native and why.
