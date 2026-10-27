/**
 * Select — THE dropdown of the signed-in app. It replaces every native
 * <select>: a native select opens the OS menu (macOS draws its own light
 * popup over a dark page), which no CSS can theme. This one opens a raised
 * menu drawn from the theme tokens, so it reads right in light and dark.
 *
 * Contract + rules: docker/ui/CLAUDE.md §8 "`Select` (all dropdowns)".
 * Styles: src/styles/select.css (`ui-select-*`, loaded once in main.tsx —
 * the header there says why).
 *
 *   <label className="dl-flabel" htmlFor={id}>Timezone</label>
 *   <Select id={id} className="dl-input vm-input-full" value={tz}
 *           onChange={setTz} options={TIMEZONES.map((z) => ({ value: z.id, label: z.label }))} />
 *
 * Closed: a <button role="combobox"> that wears the page's own class (the
 * look the native select had), or `.ui-select-default` (= .dl-input) when
 * no class is passed. Hidden "sizer" copies of the longest labels give it
 * the native select's intrinsic width (as wide as its longest option).
 *
 * Open: the menu is portaled with position: fixed — to <body>, or into the
 * trigger's aria-modal dialog so assistive tech still reaches it — placed
 * from the trigger's rect (flips up, clamps to the viewport, follows scroll
 * and resize, closes once the trigger scrolls out of sight). It carries the
 * trigger's nearest `data-force-theme` and font, and uses only tokens
 * declared on :root (--t-*, --dl-*, its own --ui-select-*).
 *
 * Keyboard (ARIA APG select-only combobox): focus stays on the trigger
 * (aria-activedescendant). ↑/↓ Home/End PageUp/PageDown move, Enter/Space
 * pick, Esc closes (focus stays), Tab closes, Alt+↓ opens, Alt+↑ picks,
 * printable keys type-ahead (closed: opens on the match). Searchable menus
 * move focus into a filter box (role=combobox) instead; it returns to the
 * trigger on close. Pointer: click toggles, outside press closes, a row
 * click picks. Presses inside the menu never reach the page (they don't
 * count as "outside" for an enclosing popover or bubble to a card's
 * onClick) — the same as a native select's OS menu.
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Search } from 'lucide-react';

/* ─── Public contract ─────────────────────────────────────────────────── */

export interface SelectOption<V extends string = string> {
  /** Handed to onChange. Unique within `options`. An option whose value is
   *  '' is a real option (e.g. "All products") — its label shows, not the
   *  placeholder. */
  value: V;
  /** Trigger text + list row. */
  label: string;
  /** Secondary, dimmer text on the row (e.g. "Suspended", "SIP Trunking"). Searchable. */
  hint?: string;
  /** Shown but never picked; the keyboard skips it. */
  disabled?: boolean;
  /** Consecutive options sharing a group render under a small uppercase group header. */
  group?: string;
  /** Extra text matched by search / type-ahead (e.g. a number's bare digits). */
  keywords?: string;
  /** Stays visible at the top while searching (e.g. "All customers"). */
  pinned?: boolean;
  /** Draw a hairline AFTER this row. */
  divider?: boolean;
}

/** `data-*` attributes are forwarded to the trigger (e.g. `data-autofocus` for VmDialog, test ids). */
interface SelectDataAttributes {
  [attribute: `data-${string}`]: string | number | boolean | undefined;
}

export interface SelectProps<V extends string = string> extends SelectDataAttributes {
  /** '' or a value with no option → shows the placeholder. */
  value: V | '';
  /** Fires only when the picked value differs from `value` (like a native change event). */
  onChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  placeholder?: string;
  /** Trigger id (for <label htmlFor>). */
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  disabled?: boolean;
  /** aria-invalid on the trigger + a danger border. */
  invalid?: boolean;
  /** aria-required on the trigger. Advisory: it does not block native form submission. */
  required?: boolean;
  /** Renders a hidden <input name value> so FormData still works. */
  name?: string;
  /** Default 'auto' = a search box when options.length > 10. */
  searchable?: boolean | 'auto';
  /** Default "Search…". */
  searchPlaceholder?: string;
  /** Default "No matches" (also shown when there are no options at all). */
  emptyText?: string;
  /** Shows a "Loading…" row under any options already present. */
  loading?: boolean;
  /** TRIGGER class. Pass the page's existing field class ('dl-input vm-scope-select') so the
   *  closed control looks exactly as before. It REPLACES the default skin — pass the full skin,
   *  not just a layout class. */
  className?: string;
  /** Extra class on the menu panel (`.ui-select-menu`). */
  menuClassName?: string;
  /** sm = compact controls like "50 per page" (default skin + denser menu rows). */
  size?: 'sm' | 'md';
  /** px; the menu is always at least the trigger's width. */
  menuMinWidth?: number;
  /** Which trigger edge the menu lines up with. Default 'start'. */
  align?: 'start' | 'end';
  /** Inline style on the trigger (extension — a few call sites set one on their native select). */
  style?: CSSProperties;
  /** Tooltip on the trigger (extension). */
  title?: string;
}

/* ─── Tunables ────────────────────────────────────────────────────────── */

/** searchable='auto' shows the search box above this many options. */
const AUTO_SEARCH_THRESHOLD = 10;
/** Gap between trigger and menu. */
const MENU_GAP = 4;
/** The menu keeps this far from every viewport edge. */
const VIEWPORT_MARGIN = 8;
const MENU_MAX_HEIGHT = 320;
/** The menu grows past the trigger's width for long labels, up to this. */
const MENU_MAX_WIDTH = 420;
/** Even in a cramped spot the menu shows at least this much (it may cover the trigger). */
const MENU_MIN_HEIGHT = 96;
/** PageUp / PageDown jump (APG: 10 options). */
const PAGE_STEP = 10;
const TYPEAHEAD_RESET_MS = 500;

/* ─── Internals ───────────────────────────────────────────────────────── */

interface Row<V extends string> {
  option: SelectOption<V>;
  /** Index in `options` — stable across filtering (DOM ids, keys, active row). */
  index: number;
}

interface Filtered<V extends string> {
  rows: Row<V>[];
  /** Rows that matched the query (pinned rows excluded); = rows.length without a query. */
  matches: number;
}

/** Per-open facts read from the trigger's context. Non-null ⇔ open. */
interface MenuSession {
  host: HTMLElement;
  theme: 'light' | 'dark' | null;
  fontFamily: string;
  name: string;
}

type ScrollIntent = 'center' | 'nearest' | 'top' | null;

interface PlaceCache {
  minW: number;
  maxW: number;
  maxH: number;
  /** Offset of the fixed containing block from the viewport (non-zero only under a transformed / filtered ancestor). */
  dx: number;
  dy: number;
}

const NO_STRINGS: readonly string[] = [];
const NO_ROWS: Filtered<never> = { rows: [], matches: 0 };

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function optionDomId(baseId: string, index: number): string {
  return `${baseId}-opt-${index}`;
}

function haystackOf(option: SelectOption<string>): string {
  return `${option.label}\n${option.hint ?? ''}\n${option.keywords ?? ''}`.toLowerCase();
}

/** Case-insensitive substring filter over label + hint + keywords; pinned rows lead while searching. */
function filterRows<V extends string>(
  options: readonly SelectOption<V>[],
  haystacks: readonly string[],
  query: string,
): Filtered<V> {
  const q = query.trim().toLowerCase();
  if (!q) return { rows: options.map((option, index) => ({ option, index })), matches: options.length };
  const pinned: Row<V>[] = [];
  const hits: Row<V>[] = [];
  options.forEach((option, index) => {
    if (option.pinned) pinned.push({ option, index });
    else if ((haystacks[index] ?? haystackOf(option)).includes(q)) hits.push({ option, index });
  });
  return { rows: pinned.concat(hits), matches: hits.length };
}

/**
 * Moves |delta| enabled rows from `from` (-1 = before the first row, or
 * after the last when delta < 0), stopping at the ends. Returns a row
 * position, or `from` when nothing further is enabled (-1 if none at all).
 */
function stepEnabled<V extends string>(rows: readonly Row<V>[], from: number, delta: number): number {
  const dir = delta > 0 ? 1 : -1;
  let remaining = Math.abs(delta);
  let pos = from < 0 ? (dir > 0 ? -1 : rows.length) : from;
  let last = from >= 0 && rows[from] && !rows[from].option.disabled ? from : -1;
  while (remaining > 0) {
    pos += dir;
    if (pos < 0 || pos >= rows.length) break;
    if (!rows[pos].option.disabled) {
      last = pos;
      remaining -= 1;
    }
  }
  return last;
}

function startsWithNeedle(option: SelectOption<string>, needle: string): boolean {
  if (option.label.toLowerCase().startsWith(needle)) return true;
  if (!option.keywords) return false;
  return option.keywords
    .toLowerCase()
    .split(/[\s,;|/]+/)
    .some((word) => word.startsWith(needle));
}

/**
 * APG type-ahead: the first enabled row after the current one whose label
 * (or a keyword) starts with the typed buffer; a repeated single letter
 * ("ccc") cycles through the rows starting with it.
 */
function findTypeahead<V extends string>(rows: readonly Row<V>[], from: number, buffer: string): number {
  const n = rows.length;
  if (n === 0 || buffer === '') return -1;
  const repeated = buffer.split('').every((ch) => ch === buffer[0]);
  const needle = repeated ? buffer[0] : buffer;
  const start = repeated ? from + 1 : Math.max(from, 0);
  for (let step = 0; step < n; step += 1) {
    const pos = (((start + step) % n) + n) % n;
    const row = rows[pos];
    if (!row.option.disabled && startsWithNeedle(row.option, needle)) return pos;
  }
  return -1;
}

/** The active row after a query change: the first real match, else the selected / first row. */
function initialActive<V extends string>(rows: readonly Row<V>[], query: string, selectedIndex: number): number {
  if (query.trim()) {
    const hit = rows.find((r) => !r.option.pinned && !r.option.disabled) ?? rows.find((r) => !r.option.disabled);
    return hit ? hit.index : -1;
  }
  const selected = rows.find((r) => r.index === selectedIndex && !r.option.disabled);
  if (selected) return selected.index;
  const first = rows.find((r) => !r.option.disabled);
  return first ? first.index : -1;
}

function allRows<V extends string>(options: readonly SelectOption<V>[]): Row<V>[] {
  return options.map((option, index) => ({ option, index }));
}

/**
 * The longest labels (by length — a cheap proxy for rendered width, one
 * pass even for 500 options) + the placeholder. Rendered invisibly in the
 * trigger's value cell so it is as wide as a native select would be.
 */
function sizerLabels(options: readonly SelectOption<string>[], placeholder: string | undefined): string[] {
  const top: string[] = [];
  for (const { label } of options) {
    if (top.length < 3) top.push(label);
    else {
      let shortest = 0;
      for (let i = 1; i < top.length; i += 1) if (top[i].length < top[shortest].length) shortest = i;
      if (label.length > top[shortest].length) top[shortest] = label;
    }
  }
  if (placeholder) top.push(placeholder);
  return top;
}

function isTypeaheadKey(e: ReactKeyboardEvent): boolean {
  return e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
}

function forcedThemeOf(el: Element): 'light' | 'dark' | null {
  const pinned = el.closest('[data-force-theme]')?.getAttribute('data-force-theme');
  return pinned === 'light' || pinned === 'dark' ? pinned : null;
}

/**
 * Where the menu lives. A modal dialog (aria-modal) hides everything
 * outside it from assistive tech, so a menu opened from inside one is
 * portaled into the dialog; everything else goes to <body>. The menu is
 * position: fixed either way (dialog panels carry no persistent transform,
 * so their overflow doesn't clip it — placeMenu corrects for one if a
 * future panel does).
 */
function portalHostOf(el: Element): HTMLElement {
  return el.closest<HTMLElement>('[aria-modal="true"]') ?? document.body;
}

/** The trigger's accessible name, for the listbox / search box labels. */
function accessibleNameOf(trigger: HTMLButtonElement, ariaLabel?: string, labelledBy?: string): string {
  if (ariaLabel) return ariaLabel;
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .filter((ref) => ref !== trigger.id)
      .map((ref) => document.getElementById(ref)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  return trigger.labels?.[0]?.textContent?.trim() ?? '';
}

/** Ancestors that clip the trigger (cards, ScrollAreas, dialog bodies) — up to the first fixed one. */
function clippingAncestors(el: Element): Element[] {
  const out: Element[] = [];
  for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) out.push(node);
    if (style.position === 'fixed') break;
  }
  return out;
}

/** False once the trigger is scrolled out of the viewport or out of a clipping ancestor. */
function isAnchorVisible(trigger: Element, clippers: readonly Element[]): boolean {
  const r = trigger.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
  return clippers.every((c) => {
    const b = c.getBoundingClientRect();
    return r.bottom > b.top && r.top < b.bottom && r.right > b.left && r.left < b.right;
  });
}

interface PlaceParts {
  trigger: HTMLElement;
  pop: HTMLElement;
  menu: HTMLElement;
  scroll: HTMLElement;
}

/**
 * Positions the fixed menu from the trigger's rect: at least the trigger's
 * width (up to MENU_MAX_WIDTH for long labels), below it unless there is
 * more room above, ≤ MENU_MAX_HEIGHT, clamped VIEWPORT_MARGIN inside the
 * viewport. An upward menu is anchored by its bottom edge so it stays on
 * the trigger while a search shrinks it. Writes styles directly (no React
 * state), so following scroll never re-renders 500 rows.
 */
function placeMenu({ trigger, pop, menu, scroll }: PlaceParts, cache: PlaceCache, minWidth: number | undefined, align: 'start' | 'end'): void {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const rect = trigger.getBoundingClientRect();

  const room = Math.max(0, vw - 2 * VIEWPORT_MARGIN);
  const minW = Math.min(Math.max(rect.width, minWidth ?? 0), room);
  const maxW = Math.min(Math.max(minW, MENU_MAX_WIDTH), room);
  if (cache.minW !== minW) {
    pop.style.minWidth = `${minW}px`;
    cache.minW = minW;
  }
  if (cache.maxW !== maxW) {
    pop.style.maxWidth = `${maxW}px`;
    cache.maxW = maxW;
  }

  // Natural height = the non-scrolling chrome (search box, padding, border) + all rows.
  const natural = menu.offsetHeight - scroll.clientHeight + scroll.scrollHeight;
  const wanted = Math.min(natural, MENU_MAX_HEIGHT);
  const below = vh - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
  const up = wanted > below && above > below;
  const maxH = Math.max(Math.min(wanted, up ? above : below), Math.min(wanted, MENU_MIN_HEIGHT));
  if (cache.maxH !== maxH) {
    pop.style.setProperty('--ui-select-max-h', `${maxH}px`);
    cache.maxH = maxH;
  }

  const w = pop.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(align === 'end' ? rect.right - w : rect.left, vw - VIEWPORT_MARGIN - w));
  const top = Math.max(VIEWPORT_MARGIN, Math.min(up ? rect.top - MENU_GAP - h : rect.bottom + MENU_GAP, vh - VIEWPORT_MARGIN - h));
  const anchorBottom = up && top > VIEWPORT_MARGIN;

  const apply = (): void => {
    pop.style.left = `${left - cache.dx}px`;
    if (anchorBottom) {
      pop.style.top = 'auto';
      pop.style.bottom = `${vh - (top + h) + cache.dy}px`;
    } else {
      pop.style.bottom = 'auto';
      pop.style.top = `${top - cache.dy}px`;
    }
  };
  apply();
  pop.dataset.placement = up ? 'top' : 'bottom';

  // A transformed / filtered ancestor of the portal host would make it the
  // fixed containing block; measure once and shift by the difference.
  const placed = pop.getBoundingClientRect();
  const ex = placed.left - left;
  const ey = anchorBottom ? placed.bottom - (top + h) : placed.top - top;
  if (Math.abs(ex) > 0.5 || Math.abs(ey) > 0.5) {
    cache.dx += ex;
    cache.dy += ey;
    apply();
  }
}

/** Scrolls the menu so `row` shows (a first-in-group row brings its header along). */
function revealRow(scroll: HTMLElement, row: HTMLElement | null, intent: Exclude<ScrollIntent, null>): void {
  if (!row || intent === 'top') {
    scroll.scrollTop = 0;
    return;
  }
  const group = row.parentElement?.classList.contains('ui-select-grp') ? row.parentElement : null;
  const firstInGroup = group !== null && group.querySelector('[role="option"]') === row;
  const top = firstInGroup && group ? group.offsetTop : row.offsetTop;
  const bottom = row.offsetTop + row.offsetHeight;
  const view = scroll.clientHeight;
  if (intent === 'center') {
    scroll.scrollTop = Math.max(0, top - (view - (bottom - top)) / 2);
  } else if (top < scroll.scrollTop) {
    scroll.scrollTop = Math.max(0, top - 4);
  } else if (bottom > scroll.scrollTop + view) {
    scroll.scrollTop = bottom - view + 4;
  }
}

function stopPropagation(e: SyntheticEvent): void {
  e.stopPropagation();
}

/* ─── One row ─────────────────────────────────────────────────────────── */

interface OptionRowProps {
  option: SelectOption<string>;
  index: number;
  domId: string;
  selected: boolean;
  active: boolean;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

/** Memoised so moving the highlight re-renders two rows, not the whole list. */
const OptionRow = memo(function OptionRow({ option, index, domId, selected, active, onPick, onHover }: OptionRowProps) {
  const { label, hint, disabled = false, divider = false } = option;
  const rowClass = cx(
    'ui-select-opt',
    active && 'ui-select-opt--active',
    selected && 'ui-select-opt--selected',
    disabled && 'ui-select-opt--disabled',
  );
  const onPointerMove =
    disabled || active
      ? undefined
      : (e: ReactPointerEvent<HTMLDivElement>) => {
          if (e.pointerType !== 'touch') onHover(index);
        };
  return (
    <>
      <div
        id={domId}
        role="option"
        aria-selected={selected}
        aria-disabled={disabled || undefined}
        data-index={index}
        className={rowClass}
        title={hint ? `${label} · ${hint}` : label}
        onPointerMove={onPointerMove}
        onClick={disabled ? undefined : () => onPick(index)}
      >
        <span className="ui-select-opt-label">{label}</span>
        {hint && <span className="ui-select-opt-hint">{hint}</span>}
        <span className="ui-select-opt-check" aria-hidden="true">
          {selected && <Check size={14} strokeWidth={2.5} />}
        </span>
      </div>
      {divider && <div className="ui-select-divider" aria-hidden="true" />}
    </>
  );
});

/* ─── The component ───────────────────────────────────────────────────── */

export function Select<V extends string = string>(props: SelectProps<V>): JSX.Element {
  const {
    value,
    onChange,
    options,
    placeholder,
    id,
    disabled = false,
    invalid = false,
    required = false,
    name,
    searchable = 'auto',
    searchPlaceholder = 'Search…',
    emptyText = 'No matches',
    loading = false,
    className,
    menuClassName,
    size = 'md',
    menuMinWidth,
    align = 'start',
    style,
    title,
  } = props;
  const ariaLabel = props['aria-label'];
  const ariaLabelledBy = props['aria-labelledby'];
  const ariaDescribedBy = props['aria-describedby'];

  // ── ALL hooks unconditionally at the top (React #310 — docker/ui/CLAUDE.md §13) ──
  const baseId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollIntentRef = useRef<ScrollIntent>(null);
  const typeaheadRef = useRef<{ buffer: string; timer: number }>({ buffer: '', timer: 0 });
  const [session, setSession] = useState<MenuSession | null>(null);
  const [query, setQuery] = useState('');
  /** Index in `options` of the highlighted row (aria-activedescendant); -1 = none. */
  const [activeIndex, setActiveIndex] = useState(-1);
  const [prevDisabled, setPrevDisabled] = useState(disabled);

  const open = session !== null;
  const searchOn = searchable === true || (searchable === 'auto' && options.length > AUTO_SEARCH_THRESHOLD);
  const listboxId = `${baseId}-listbox`;

  const selectedIndex = useMemo(() => options.findIndex((o) => o.value === value), [options, value]);
  const sizers = useMemo(() => sizerLabels(options, placeholder), [options, placeholder]);
  // Search text is built only while a searchable menu is open.
  const haystacks = useMemo(() => (open && searchOn ? options.map(haystackOf) : NO_STRINGS), [open, searchOn, options]);
  const filtered = useMemo<Filtered<V>>(
    () => (open ? filterRows(options, haystacks, searchOn ? query : '') : NO_ROWS),
    [open, options, haystacks, searchOn, query],
  );
  const rows = filtered.rows;
  const activePos = useMemo(() => rows.findIndex((r) => r.index === activeIndex), [rows, activeIndex]);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setSession(null);
    setQuery('');
    const typeahead = typeaheadRef.current;
    window.clearTimeout(typeahead.timer);
    typeahead.buffer = '';
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = useCallback(
    (active: number, seedQuery: string) => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      setSession({
        host: portalHostOf(trigger),
        theme: forcedThemeOf(trigger),
        fontFamily: getComputedStyle(trigger).fontFamily,
        name: accessibleNameOf(trigger, ariaLabel, ariaLabelledBy),
      });
      setQuery(seedQuery);
      setActiveIndex(active);
      scrollIntentRef.current = seedQuery ? 'top' : 'center';
      // Safari doesn't focus a clicked <button>; the keyboard needs it there.
      if (!searchOn) trigger.focus({ preventScroll: true });
    },
    [ariaLabel, ariaLabelledBy, searchOn],
  );

  const pick = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      closeMenu(true);
      if (option.value !== value) onChange(option.value);
    },
    [options, value, onChange, closeMenu],
  );

  const hover = useCallback((index: number) => {
    scrollIntentRef.current = null;
    setActiveIndex(index);
  }, []);

  // A trigger disabled while its menu is open closes it (state adjusted during render, not in an effect).
  if (prevDisabled !== disabled) {
    setPrevDisabled(disabled);
    if (disabled) setSession(null);
  }

  // Place the menu, then follow the trigger (scroll anywhere, resize, content changes).
  useLayoutEffect(() => {
    if (!session) return undefined;
    const trigger = triggerRef.current;
    const pop = popRef.current;
    const menu = menuRef.current;
    const scroll = scrollRef.current;
    if (!trigger || !pop || !menu || !scroll) return undefined;
    const parts: PlaceParts = { trigger, pop, menu, scroll };
    const cache: PlaceCache = { minW: -1, maxW: -1, maxH: -1, dx: 0, dy: 0 };
    const clippers = clippingAncestors(trigger);
    placeMenu(parts, cache, menuMinWidth, align);

    let frame = 0;
    const update = (): void => {
      frame = 0;
      if (!isAnchorVisible(trigger, clippers)) {
        closeMenu(pop.contains(document.activeElement));
        return;
      }
      placeMenu(parts, cache, menuMinWidth, align);
    };
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    // Ignore the menu's own events (the list scrolling, its entry animation).
    const fromElsewhere = (e: Event): void => {
      if (e.target instanceof Node && pop.contains(e.target)) return;
      schedule();
    };
    window.addEventListener('scroll', fromElsewhere, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    // A dialog's entry animation (VmDialog's vm-pop) transforms the portal
    // host, making it the fixed containing block until it ends; re-place
    // then so the correction in placeMenu follows it back to the viewport.
    document.addEventListener('animationend', fromElsewhere, true);
    document.addEventListener('transitionend', fromElsewhere, true);
    // Rows arriving (loading → loaded) or the trigger resizing. rAF-batched,
    // so a resize caused by our own max-height never loops the observer.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(trigger);
    if (scroll.firstElementChild) observer?.observe(scroll.firstElementChild);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', fromElsewhere, { capture: true });
      window.removeEventListener('resize', schedule);
      document.removeEventListener('animationend', fromElsewhere, true);
      document.removeEventListener('transitionend', fromElsewhere, true);
      observer?.disconnect();
    };
  }, [session, menuMinWidth, align, closeMenu]);

  // Searchable: the caret goes into the search box (after placement, so nothing scrolls).
  useLayoutEffect(() => {
    if (!session || !searchOn) return;
    const input = searchRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [session, searchOn]);

  // Keep the highlighted row in view after keyboard moves, opening, filtering.
  useLayoutEffect(() => {
    const intent = scrollIntentRef.current;
    const scroll = scrollRef.current;
    if (!session || intent === null || !scroll) return;
    scrollIntentRef.current = null;
    const row = activeIndex >= 0 ? scroll.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`) : null;
    revealRow(scroll, row, intent);
  }, [session, activeIndex, filtered]);

  // Outside press / focus moving elsewhere closes (without stealing focus back).
  useEffect(() => {
    if (!session) return undefined;
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && (triggerRef.current?.contains(target) === true || popRef.current?.contains(target) === true);
    const onPointerDown = (e: PointerEvent): void => {
      if (!inside(e.target)) closeMenu(false);
    };
    const onFocusIn = (e: FocusEvent): void => {
      if (!inside(e.target)) closeMenu(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [session, closeMenu]);

  useEffect(() => {
    const typeahead = typeaheadRef.current;
    return () => window.clearTimeout(typeahead.timer);
  }, []);

  /* ── Event handlers (after all hooks) ── */

  const selectedOrFirst = (): number => {
    if (selectedIndex >= 0 && !options[selectedIndex].disabled) return selectedIndex;
    return options.findIndex((o) => !o.disabled);
  };

  const typeAhead = (char: string, list: readonly Row<V>[], from: number): number => {
    const typeahead = typeaheadRef.current;
    window.clearTimeout(typeahead.timer);
    typeahead.buffer += char.toLowerCase();
    typeahead.timer = window.setTimeout(() => {
      typeahead.buffer = '';
    }, TYPEAHEAD_RESET_MS);
    return findTypeahead(list, from, typeahead.buffer);
  };

  const moveTo = (pos: number): void => {
    if (pos < 0 || !rows[pos]) return;
    scrollIntentRef.current = 'nearest';
    setActiveIndex(rows[pos].index);
  };

  const pickActive = (): void => {
    if (activePos >= 0) pick(activeIndex);
    else closeMenu(true);
  };

  const onTriggerClick = (): void => {
    if (open) closeMenu(true);
    else openMenu(selectedOrFirst(), '');
  };

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.nativeEvent.isComposing) return;
    const { key } = e;

    if (!open) {
      let active: number | null = null;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') active = selectedOrFirst();
      else if (key === 'Home') active = options.findIndex((o) => !o.disabled);
      else if (key === 'End') active = options.findLastIndex((o) => !o.disabled);
      else if (isTypeaheadKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (searchOn) {
          // Type-to-search: the key seeds the search box.
          const seeded = filterRows(options, options.map(haystackOf), key);
          openMenu(initialActive(seeded.rows, key, selectedIndex), key);
        } else {
          const list = allRows(options);
          const pos = typeAhead(key, list, selectedIndex);
          openMenu(pos >= 0 ? list[pos].index : selectedOrFirst(), '');
        }
        return;
      }
      if (active === null) return; // Esc, Tab… stay with the page (a dialog's Esc still closes it)
      e.preventDefault();
      e.stopPropagation();
      openMenu(active, '');
      return;
    }

    if (searchOn) {
      // Focus normally sits in the search box; the trigger only holds it mid-click.
      if (key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      }
      return;
    }

    switch (key) {
      case 'ArrowDown':
        moveTo(stepEnabled(rows, activePos, 1));
        break;
      case 'ArrowUp':
        if (e.altKey) pickActive();
        else moveTo(stepEnabled(rows, activePos, -1));
        break;
      case 'Home':
        moveTo(stepEnabled(rows, -1, 1));
        break;
      case 'End':
        moveTo(stepEnabled(rows, -1, -1));
        break;
      case 'PageDown':
        moveTo(stepEnabled(rows, activePos, PAGE_STEP));
        break;
      case 'PageUp':
        moveTo(stepEnabled(rows, activePos, -PAGE_STEP));
        break;
      case 'Enter':
        pickActive();
        break;
      case ' ':
        // Mid type-ahead ("new y…") a space is part of the word.
        if (typeaheadRef.current.buffer) moveTo(typeAhead(key, rows, activePos));
        else pickActive();
        break;
      case 'Escape':
        closeMenu(true);
        break;
      case 'Tab':
        closeMenu(false); // and let the browser move focus on
        return;
      default:
        if (!isTypeaheadKey(e)) return;
        moveTo(typeAhead(key, rows, activePos));
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // Firefox clicks a button on Space keyup even when keydown was prevented.
  const onTriggerKeyUp = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === ' ') e.preventDefault();
  };

  const onSearchChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value;
    setQuery(next);
    setActiveIndex(initialActive(filterRows(options, haystacks, next).rows, next, selectedIndex));
    scrollIntentRef.current = next.trim() ? 'top' : 'center';
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        moveTo(stepEnabled(rows, activePos, 1));
        break;
      case 'ArrowUp':
        if (e.altKey) pickActive();
        else moveTo(stepEnabled(rows, activePos, -1));
        break;
      case 'PageDown':
        moveTo(stepEnabled(rows, activePos, PAGE_STEP));
        break;
      case 'PageUp':
        moveTo(stepEnabled(rows, activePos, -PAGE_STEP));
        break;
      case 'Enter':
        if (activePos >= 0) pick(activeIndex);
        break;
      case 'Escape':
        closeMenu(true);
        break;
      case 'Tab':
        // Back on the trigger first, so Tab moves on from there and a
        // dialog's Tab trap sees focus inside the dialog.
        closeMenu(true);
        return;
      default:
        e.stopPropagation(); // typing stays in the box (no page shortcuts)
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // Presses inside the menu keep focus where it is (trigger or search box) and never reach the page.
  const onPopMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (e.target !== searchRef.current) e.preventDefault();
  };

  /* ── Render ── */

  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const shown = selected ? selected.label : (placeholder ?? '');
  const activeId = open && activePos >= 0 ? optionDomId(baseId, activeIndex) : undefined;

  const dataAttributes: Record<string, string | number | boolean | undefined> = {};
  for (const [key, attr] of Object.entries(props)) {
    if (key.startsWith('data-')) dataAttributes[key] = attr as string | number | boolean | undefined;
  }

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      id={id}
      className={cx(
        'ui-select-trigger',
        className || cx('ui-select-default', size === 'sm' && 'ui-select-default--sm'),
        open && 'ui-select-trigger--open',
      )}
      style={style}
      title={title}
      disabled={disabled}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={searchOn ? undefined : activeId}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid || undefined}
      aria-required={required || undefined}
      onClick={onTriggerClick}
      onKeyDown={onTriggerKeyDown}
      onKeyUp={onTriggerKeyUp}
      {...dataAttributes}
    >
      <span className="ui-select-value">
        <span className={selected ? 'ui-select-text' : 'ui-select-text ui-select-placeholder'}>{shown || ' '}</span>
        {sizers.map((label, i) => (
          <span key={i} className="ui-select-text ui-select-sizer" aria-hidden="true">
            {label}
          </span>
        ))}
      </span>
      <svg className="ui-select-chevron" viewBox="0 0 11 7" fill="none" aria-hidden="true" focusable="false">
        <path d="M1 1.25 5.5 5.75 10 1.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  let menu: ReactNode = null;
  if (session) {
    const renderRow = (row: Row<V>): ReactNode => (
      <OptionRow
        key={row.index}
        option={row.option}
        index={row.index}
        domId={optionDomId(baseId, row.index)}
        selected={row.index === selectedIndex}
        active={row.index === activeIndex}
        onPick={pick}
        onHover={hover}
      />
    );
    // Consecutive options sharing a `group` go under one header.
    const items: ReactNode[] = [];
    for (let pos = 0; pos < rows.length; ) {
      const group = rows[pos].option.group;
      if (!group) {
        items.push(renderRow(rows[pos]));
        pos += 1;
        continue;
      }
      const start = pos;
      while (pos < rows.length && rows[pos].option.group === group) pos += 1;
      const headId = `${baseId}-grp-${rows[start].index}`;
      items.push(
        <div key={headId} role="group" aria-labelledby={headId} className="ui-select-grp">
          <div id={headId} role="presentation" className="ui-select-group">
            {group}
          </div>
          {rows.slice(start, pos).map(renderRow)}
        </div>,
      );
    }

    const searching = searchOn && query.trim() !== '';
    let statusText = '';
    if (loading) statusText = 'Loading…';
    else if (searching ? filtered.matches === 0 : options.length === 0) statusText = emptyText;
    const announce =
      searching && !loading && filtered.matches > 0 ? `${filtered.matches} ${filtered.matches === 1 ? 'match' : 'matches'}` : '';
    const listName = session.name || 'Options';

    menu = createPortal(
      <div
        ref={popRef}
        className="ui-select-pop"
        data-force-theme={session.theme ?? undefined}
        style={{ fontFamily: session.fontFamily }}
        onPointerDown={stopPropagation}
        onMouseDown={onPopMouseDown}
        onClick={stopPropagation}
      >
        <div ref={menuRef} className={cx('ui-select-menu', size === 'sm' && 'ui-select-menu--sm', menuClassName)}>
          {searchOn && (
            <div className="ui-select-searchbox">
              <Search className="ui-select-search-icon" size={13} strokeWidth={2.2} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                className="ui-select-search"
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={activeId}
                aria-label={`Search ${listName}`}
                placeholder={searchPlaceholder}
                value={query}
                onChange={onSearchChange}
                onKeyDown={onSearchKeyDown}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          )}
          <div ref={scrollRef} className="ui-select-scroll">
            <div id={listboxId} role="listbox" aria-label={listName} className="ui-select-listbox">
              {items}
            </div>
            <div role="status" className="ui-select-statusbox">
              {statusText && <div className="ui-select-status">{statusText}</div>}
              {announce && <span className="ui-select-sr">{announce}</span>}
            </div>
          </div>
        </div>
      </div>,
      session.host,
    );
  }

  return (
    <>
      {trigger}
      {name !== undefined && <input type="hidden" name={name} value={value} disabled={disabled} />}
      {menu}
    </>
  );
}
