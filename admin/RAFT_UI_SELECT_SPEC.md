# raft-ui elegant — Select conversion spec (task #129, pass 2)

Convert raw `<select>` elements to raft-ui's compositional Select. This is
HIGHER RISK than buttons — base-ui Select value semantics differ from native.
Preserve EXACT behavior. When a select is genuinely awkward to convert (see
"leave native" below), leave it native rather than introduce a bug.

## Import
Extend the existing `raft-ui` import to add exactly what you use:
```ts
import { Select, SelectTrigger, SelectValue, SelectIcon, SelectContent, SelectItem } from "raft-ui";
```

## The mapping

Native:
```tsx
<select
  value={status}
  onChange={(e) => setStatus(e.target.value)}
  className="input text-xs"
>
  <option value="">All statuses</option>
  <option value="open">Open</option>
  <option value="closed">Closed</option>
</select>
```

raft-ui:
```tsx
<Select
  items={{ "": "All statuses", open: "Open", closed: "Closed" }}
  value={status}
  onValueChange={(v) => setStatus(v as string)}
>
  <SelectTrigger className="text-xs">
    <SelectValue />
    <SelectIcon />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="">All statuses</SelectItem>
    <SelectItem value="open">Open</SelectItem>
    <SelectItem value="closed">Closed</SelectItem>
  </SelectContent>
</Select>
```

### Critical rules
1. **`onChange={(e) => f(e.target.value)}` → `onValueChange={(v) => f(v as string)}`.**
   base-ui gives you the VALUE directly, not an event. Update the handler body
   to use `v` instead of `e.target.value`. Keep the same setter/logic.
2. **`items` prop is REQUIRED for the label to render in the closed trigger.**
   Build it as a record `{ [value]: label }` (or `[{value,label}]` array) mapping
   EACH option's value → its visible label. `<SelectValue />` uses `items` to show
   the current selection's label. If options are generated from a `.map`, build
   `items` from the same source (e.g.
   `Object.fromEntries(roles.map(r => [r.value, r.label]))`), and render the
   `<SelectItem>`s from the same `.map`.
3. **Option values are strings.** If the native select coerced numbers, keep the
   value as the string it currently is and coerce in the handler exactly as the
   old `onChange` did.
4. Move the `<select>`'s residual utility classes onto `<SelectTrigger>` (drop
   the prestyled `input` class). Keep `disabled`, `name`, `aria-*` on `<Select>`
   or the trigger as appropriate (`disabled` goes on `<Select>`).
5. Preserve keys on mapped `<SelectItem>`s (`key={...}`).
6. `<SelectValue />` + `<SelectIcon />` go INSIDE `<SelectTrigger>`. `<SelectItem>`s
   go inside `<SelectContent>` (which internally provides the portal/popup — no
   extra wrappers needed). `<SelectItem>` renders its children as the label.

## LEAVE NATIVE (do not convert) if ANY of these hold
- The select is a `multiple` select.
- Options are deeply dynamic in a way that makes an accurate `items` map
  impractical without risking a wrong label.
- The select's value is not a plain string/number the handler maps cleanly.
If you leave one native, say so and why.

## After editing
Do NOT run a build. Report: file, # selects converted, # left native (and why).
Be precise about any handler-body changes you made (e.g. numeric coercion).
