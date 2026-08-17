import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';

/* ─────────────────────────────────────────────────────────────
   LandingSelect — custom listbox for the landing intake form.

   Native <select> popups can't be styled and render as a light
   translucent OS list over the dark cobalt band. This replaces
   them with the ARIA select-only-combobox pattern: a button that
   matches .landing-input exactly, opening a solid granite-navy
   panel. Focus stays on the button (aria-activedescendant), so
   Escape "returns" focus for free and Tab order is untouched.

   Styling: .landing-select-* in index.css ("LANDING PAGE").
   ───────────────────────────────────────────────────────────── */

interface LandingSelectProps {
  /** DOM id for the trigger button (the field <label htmlFor> target). */
  id: string;
  /** id of the visible field label, for aria-labelledby. */
  labelId: string;
  value: string;
  options: readonly string[];
  placeholder: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}

/** Vertical room the popup needs before it flips upward (max-height + gap). */
const POPUP_CLEARANCE_PX = 300;

/** Type-ahead buffer resets after this pause. */
const TYPEAHEAD_RESET_MS = 550;

export function LandingSelect({
  id,
  labelId,
  value,
  options,
  placeholder,
  onChange,
  disabled,
  invalid,
}: LandingSelectProps) {
  // ALL hooks unconditionally at the top — React #310 prevention.
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ buffer: string; timer: number }>({ buffer: '', timer: 0 });

  const listId = `${id}-listbox`;

  const openList = useCallback(() => {
    const btn = buttonRef.current;
    if (btn) {
      // Flip upward when the popup would clip the viewport bottom.
      const rect = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUp(spaceBelow < POPUP_CLEARANCE_PX && rect.top > spaceBelow);
    }
    const selected = options.indexOf(value);
    setHighlighted(selected >= 0 ? selected : 0);
    setOpen(true);
  }, [options, value]);

  const commit = useCallback(
    (index: number) => {
      const next = options[index];
      if (next !== undefined) onChange(next);
      setOpen(false);
      buttonRef.current?.focus();
    },
    [onChange, options],
  );

  // Close on any pointer press outside the component.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Keep the highlighted row visible while navigating a scrolled list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, highlighted]);

  const handleTypeahead = useCallback(
    (char: string) => {
      const state = typeahead.current;
      window.clearTimeout(state.timer);
      state.buffer += char.toLowerCase();
      state.timer = window.setTimeout(() => {
        state.buffer = '';
      }, TYPEAHEAD_RESET_MS);
      // Search from the row after the highlight, wrapping around.
      const start = state.buffer.length === 1 ? highlighted + 1 : highlighted;
      for (let step = 0; step < options.length; step += 1) {
        const i = (start + step) % options.length;
        if (options[i].toLowerCase().startsWith(state.buffer)) {
          setHighlighted(i);
          return;
        }
      }
    },
    [highlighted, options],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!open) {
        // Enter / Space fall through to the native button click → toggle.
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          openList();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlighted((i) => Math.min(i + 1, options.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlighted((i) => Math.max(i - 1, 0));
          break;
        case 'Home':
          e.preventDefault();
          setHighlighted(0);
          break;
        case 'End':
          e.preventDefault();
          setHighlighted(options.length - 1);
          break;
        case 'Enter':
        case ' ':
          // preventDefault stops the button's synthetic click from re-toggling.
          e.preventDefault();
          commit(highlighted);
          break;
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          buttonRef.current?.focus();
          break;
        case 'Tab':
          setOpen(false);
          break;
        default:
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            handleTypeahead(e.key);
          }
      }
    },
    [open, openList, options.length, commit, highlighted, handleTypeahead],
  );

  const buttonClass = [
    'landing-input',
    'landing-select-btn',
    invalid ? 'landing-input-invalid' : '',
    open ? 'landing-select-btn-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="landing-select" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        className={buttonClass}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelId} ${id}`}
        aria-activedescendant={open ? `${listId}-opt-${highlighted}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleKeyDown}
      >
        <span
          className={
            value
              ? 'landing-select-value'
              : 'landing-select-value landing-select-placeholder'
          }
        >
          {value || placeholder}
        </span>
        <ChevronDown
          size={15}
          strokeWidth={2.25}
          className="landing-select-chevron"
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-labelledby={labelId}
          className={openUp ? 'landing-select-pop landing-select-pop-up' : 'landing-select-pop'}
        >
          {options.map((opt, i) => {
            const selected = opt === value;
            const optClass = [
              'landing-select-opt',
              i === highlighted ? 'landing-select-opt-hi' : '',
              selected ? 'landing-select-opt-selected' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div
                key={opt}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={selected}
                data-highlighted={i === highlighted}
                className={optClass}
                // Keep focus on the trigger button (activedescendant pattern).
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => commit(i)}
              >
                <span className="landing-select-opt-text">{opt}</span>
                {selected && <Check size={15} strokeWidth={2.5} aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
