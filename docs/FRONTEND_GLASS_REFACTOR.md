# Frontend "Liquid Glass" Refactor — Convention Spec

The spec every page-by-page glass rollout follows. The foundation is built; this
doc tells you how to mirror it. Reference implementation: **`docker/ui/app/src/pages/rcf-glass/`**.

The look is **liquid glass, themed in the APP BLUE** (`#3b82f6`, cyan `#22d3ee`
secondary). Frosted `backdrop-filter` surfaces float over a single, app-wide
ambient colour field.

---

## 1. Per-page folder structure (separation of concerns)

Each glassified page becomes a **feature folder** under `src/pages/<feature>/`,
not a single mega-file:

```
pages/<feature>/
  <Feature>Page.tsx   // THIN page: composition + top-level useState only
  hooks.ts            // data fetching (useQuery), mutations (useMutation), derived state
  styles.ts           // centralised CSSProperties + style builder functions
  types.ts            // local types (sort fields, view modes, page-size consts)
  components/          // dumb presentational pieces (cards, table, controls, states, icons)
```

Responsibility rules:

| File | Owns | Must NOT |
|------|------|----------|
| `<Feature>Page.tsx` | layout/composition, top-level state (`search`, `sort`, `view`, …), wiring children together | fetch data, define big inline style blocks, hold mutation logic |
| `hooks.ts` | `useQuery`/`useMutation`, query keys, derived filter/sort/slice pipelines, encapsulated per-item editor logic | render JSX |
| `styles.ts` | every reusable `CSSProperties` object + parameterised builders (`fn(accent, hovered) => CSSProperties`) | import React components |
| `components/*` | presentation; receive data + callbacks via props | call the API directly or own server state |
| `types.ts` | local unions/consts | duplicate global types from `src/types/` |

Keep page-global data types in `src/types/` (e.g. `RcfEntry`). Only feature-local
types (e.g. `SortField`, `ViewMode`, `PAGE_SIZE`) live in `types.ts`.

---

## 2. The glass kit (`src/components/glass/`)

The canonical, single-source-of-truth design system. **Do not re-implement glass
surfaces in pages — compose these.**

| Export | What |
|--------|------|
| `glass.ts` → `GLASS` | tokens: `bg`, `accent` (blue), `accentSecondary` (cyan), `text`/`textMuted`/`textFaint`, status colours |
| `glass.ts` → `glassSurface(opts)` | the shared frosted surface (fill + blur + border + sheen shadow + hover lift) |
| `glass.ts` → `hexToRgba(hex, a)` | hex → `rgba()` helper |
| `GlassBackground` | the app-wide ambient blob field (mounted once — see §4) |
| `GlassPanel` | static frosted panel (controls bar, table, state cards) |
| `GlassCard` | interactive panel: hover lift + accent glow + staggered entrance |
| `GlassChip` | small glass status pill (`color`, `dot`, `icon`) |
| `GlassSheen` | top-edge specular highlight (rendered inside panels/cards) |

### Blue default + accent override

Every primitive defaults to the app blue. Pass `accent` to re-tint **locally**
(e.g. fade a disabled card to `GLASS.textFaint`, or opt a page back to the legacy
RCF green `GLASS.green`):

```tsx
import { GlassCard, GlassChip } from '@/components/glass/GlassCard';
import { GLASS } from '@/components/glass/glass';

// default blue
<GlassCard index={i}>{/* … */}</GlassCard>

// local override — disabled rows fade out
<GlassCard index={i} accent={entry.enabled ? GLASS.accent : GLASS.textFaint}>
  <GlassChip label="Active" color={GLASS.accent} dot />
</GlassCard>
```

`GlassChip` keeps a semantic `color` prop (it represents a status, not the page
accent). `GlassBackground` takes `accent` + `secondary`.

---

## 3. The Sidebar exception

**Do NOT touch the Sidebar's colours.** `Sidebar.tsx` keeps its own per-product
accent system (RCF green, trunks amber, API purple, Flow Builder cyan). The glass
backdrop sits *behind* it (`zIndex:0` vs the sidebar's `zIndex:100`) and never
recolours or covers it.

---

## 4. The app-wide background (already mounted)

`GlassBackground` is mounted **once** in `components/layout/AppLayout.tsx`, behind
the centered content (`<main>` is lifted to `position:relative; zIndex:1`) and
behind the Sidebar. So:

- **Every page inside AppLayout already sits on the liquid-glass backdrop.** Do
  not mount your own `GlassBackground` — just build glass surfaces on top.
- It is intentionally subtle (dark `#0f1117` base + low-opacity blobs), so
  not-yet-glassified pages with opaque surfaces still read fine.
- `GlassBackground` also injects the shared keyframes (`glass-rise`,
  `glass-shimmer`, `glass-spin`, `glass-drift-*`) that `GlassCard` / skeletons /
  spinners rely on. These are available to any AppLayout page for free.

**Full-screen routes outside AppLayout** (`/flows`, `/troubleshooting`, the
full-screen UCaaS pages) render their own Sidebar and are NOT yet on the backdrop.
When glassifying one, mount `<GlassBackground />` at the top of that page's tree
(so its keyframes + field are present).

---

## 5. Hard rules (React #310 + tsc strict)

1. **Every hook is called unconditionally at the top of the component, before any
   early return or conditional.** React error #310 has hit this codebase three
   times. To skip a query, use `enabled:` — never a conditional hook call. Custom
   logic hooks (e.g. `useForwardToEditor`) must follow the same rule internally.
2. **No unused imports/locals.** `tsconfig` runs `noUnusedLocals/Parameters`;
   unused imports break the Docker build.
3. **Icon/helper files that a `components/` folder imports**: if a file exports
   non-component values alongside JSX, `react-refresh/only-export-components` will
   error. Keep icon files exporting *only components* (zero-prop components, used
   as `<IconClock />`), or move shared constants/functions to a non-`.tsx` module.
4. **Before pushing:** `cd docker/ui/app && npx tsc --noEmit && npm run lint`.

### Minimal page skeleton

```tsx
// pages/<feature>/<Feature>Page.tsx
import { useState } from 'react';
import { GLASS } from '@/components/glass/glass';
import { useFeatureData } from './hooks';
import { GlassControlsBar } from './components/GlassControlsBar';

export function FeaturePage() {
  // 1) ALL hooks first — no early return above this block
  const [search, setSearch] = useState('');
  const { rows, isLoading, isError } = useFeatureData({ search });

  // 2) composition only — surfaces come from the kit, styles from styles.ts
  return (
    <>
      <GlassControlsBar search={search} onSearch={setSearch} />
      {/* loading / error / empty / data states … */}
    </>
  );
}
```

---

## 7. Spacing standard (app-wide)

The content container's padding is owned **centrally** by
`components/layout/AppLayout.tsx`. Every routed page renders inside a single
centered, padded column, so the top offset and gutters are applied once for the
whole app. **Pages must not re-pad the top edge** — that is what previously made
pages look "glued to the top".

### Container (set in `AppLayout.tsx` — do not duplicate per page)

All three gutters are **fluid (`clamp`)** so horizontal and vertical breathing
room scale together across viewport sizes.

| Token | Value | Meaning |
|-------|-------|---------|
| `PAGE_PADDING_X` | `clamp(24px, 3vw, 48px)` | left/right gutter — 24px on mobile → 48px on wide screens |
| `PAGE_PADDING_TOP` | `clamp(32px, 4vh, 48px)` | comfortable top offset (min **32px**, never glued); first element (usually `PageHeader`) starts here |
| `PAGE_PADDING_BOTTOM` | `clamp(64px, 8vh, 96px)` | tail so the last row clears the floating softphone widget |
| content `max-width` | `1280px` (app) / `1600px` (public `/` landing) | centered, readable measure |

### In-page rhythm (apply these inside your page)

| Token | Value | Use for |
|-------|-------|---------|
| **Section gap** | `32px` (`2rem`, Tailwind `gap-8` / `mb-8` / `space-y-8`) | vertical space between major page sections (header → first block, block → block) |
| **Card gap** | `16px` (`1rem`, Tailwind `gap-4`) | grid/flex gap between cards in a list or card grid |
| **Inset / content padding** | `20–24px` | padding *inside* a glass panel/card (matches `glassSurface` radius `20`) |
| **Control gap** | `8px` (`gap-2`) | between buttons / chips in a toolbar or actions slot |

### Top-offset rule

- The **top offset (`clamp(32px, 4vh, 48px)`) is provided by the layout, once.**
  A page's first child (normally `<PageHeader>`) must have **no top
  margin/padding** — it sits flush with the layout offset.
- `PageHeader` then enforces a **32px section gap** below itself (`mb-8`) plus a
  translucent-white hairline divider (`border-white/10`), so the first content
  block is uniformly spaced on every page.
- Between subsequent sections, use the **32px section gap**. Within a section's
  card grid/list, use the **16px card gap**. Never hand-tune one-off top margins
  to "unglue" a page — the standard already does it.

---

## 8. Checklist for a new glassified page

- [ ] Create `pages/<feature>/` with `Page.tsx` / `hooks.ts` / `styles.ts` / `types.ts` / `components/`.
- [ ] Data + mutations live in `hooks.ts`; page holds only top-level state.
- [ ] Build surfaces with `GlassPanel` / `GlassCard` / `GlassChip` — blue default, `accent` only when a local override is justified.
- [ ] Do **not** mount `GlassBackground` (AppLayout already did) unless the route is full-screen outside AppLayout.
- [ ] Do **not** touch Sidebar colours.
- [ ] All hooks at the top; no unused imports; icon files export only components.
- [ ] `npx tsc --noEmit` + `npm run lint` clean.
