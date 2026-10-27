/**
 * BlockForms — the settings of each block type in the inspector, worded
 * for customers. Every field is labelled; every edit goes through the
 * store's `updateConfig` (undoable; typing in one field is one undo step).
 * Read-only viewers see the same forms with controls disabled.
 */
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarX2, Copy, Plus, X } from 'lucide-react';
import type { DayKey, IvrConfigMap, IvrTimezone, MenuDigit, TimeRange } from '../../types/ivr';
import { Select, type SelectOption } from '../../components/ui/Select';
import { fmt } from '../../utils/format';
import { BLOCKS, DAY_KEYS, DAY_LABELS, DIGIT_ORDER, LIMITS, TIMEZONES, sortDigits } from '../model/blocks';
import { blockTitle } from '../model/summary';
import { callerValueProblem, normalizeCallerValue } from '../compile/policy';
import { useBuilderData } from '../BuilderData';
import { useFlow, useFlowStoreApi, type FlowNode } from '../store/flowStore';
import { useIvrWorkspace } from '../../pages/ivr/IvrContext';
import { PromptListField } from './PromptListField';
import { TransferPicker } from './TransferPicker';
import { ProductGlyph } from './ProductGlyph';
import { findOwnNumber, orderedGroups } from './destinations';

/**
 * Every dropdown here is the themed Select (docker/ui/CLAUDE.md §8) in the
 * field skin. `nokey`: React Flow ignores its Delete / Backspace shortcut
 * while a `.nokey` element has focus — the native <select> it replaced was
 * ignored as an input, a <button> trigger isn't.
 */
const FIELD_SELECT = 'dl-input vm-input-full nokey';

const TIMEZONE_OPTIONS: readonly SelectOption<IvrTimezone>[] = TIMEZONES.map((t) => ({ value: t.id, label: t.label }));

type Patch<T extends keyof IvrConfigMap> = (patch: Partial<IvrConfigMap[T]>, key?: string) => void;

interface FormProps<T extends keyof IvrConfigMap> {
  node: FlowNode;
  config: IvrConfigMap[T];
  update: Patch<T>;
  readOnly: boolean;
}

/* ─── Play message ────────────────────────────────────────── */

export function PlayForm({ node, config, update, readOnly }: FormProps<'play'>) {
  const { prompts } = useBuilderData();
  return (
    <PromptListField
      label="Messages to play"
      help="Played one after another, in this order."
      value={config.prompts}
      prompts={prompts}
      onChange={(next) => update({ prompts: next })}
      forWhat={blockTitle(node)}
      readOnly={readOnly}
      emptyText="Choose what callers hear."
    />
  );
}

/* ─── Menu ────────────────────────────────────────────────── */

const RETRY_WORDS = ['Don’t ask again', 'Ask once more', 'Ask 2 more times', 'Ask 3 more times', 'Ask 4 more times', 'Ask 5 more times'];
/** Retries 0–5 as Select options (values are the count as a string). */
const RETRY_OPTIONS: readonly SelectOption[] = RETRY_WORDS.map((w, i) => ({ value: String(i), label: w }));

export function MenuForm({ node, config, update, readOnly }: FormProps<'menu'>) {
  const { prompts } = useBuilderData();
  const ids = { keys: useId(), timeout: useId(), retries: useId() };
  const [extras, setExtras] = useState(Boolean(config.invalidPrompts?.length || config.noInputPrompts?.length));
  const toggleKey = (d: MenuDigit) => {
    const has = config.digits.includes(d);
    if (has && config.digits.length <= LIMITS.digitsMin) return;
    update({ digits: sortDigits(has ? config.digits.filter((x) => x !== d) : [...config.digits, d]) });
  };
  return (
    <>
      <PromptListField
        label="Menu message"
        help="Callers can press a key at any time — they don’t have to wait for the end."
        value={config.prompts}
        prompts={prompts}
        onChange={(next) => update({ prompts: next })}
        forWhat={blockTitle(node)}
        readOnly={readOnly}
        emptyText="Choose the message that lists the options, e.g. “For sales press 1”."
      />
      <div className="ivr-field">
        <span className="ivr-label" id={ids.keys}>
          Keys callers can press
        </span>
        <div className="ivr-keypad" role="group" aria-labelledby={ids.keys}>
          {DIGIT_ORDER.map((d) => {
            const on = config.digits.includes(d);
            return (
              <button
                key={d}
                type="button"
                className={`ivr-keycap${on ? ' ivr-keycap-on' : ''}`}
                aria-pressed={on}
                aria-label={`Key ${d === '*' ? 'star' : d === '#' ? 'pound' : d}`}
                disabled={readOnly}
                onClick={() => toggleKey(d)}
              >
                {d}
              </button>
            );
          })}
        </div>
        <p className="dl-help">Each key gets its own exit below. Removing a key removes its connection too.</p>
      </div>
      <div className="ivr-field-row">
        <div className="ivr-field">
          <label className="ivr-label" htmlFor={ids.timeout}>
            Wait for a key
          </label>
          <div className="ivr-input-unit">
            <input
              id={ids.timeout}
              type="number"
              className="dl-input"
              min={LIMITS.timeoutSec.min}
              max={LIMITS.timeoutSec.max}
              value={config.timeoutSec}
              disabled={readOnly}
              onChange={(e) => update({ timeoutSec: Number(e.target.value) }, `cfg:${node.id}:timeout`)}
            />
            <span>seconds</span>
          </div>
        </div>
        <div className="ivr-field">
          <label className="ivr-label" htmlFor={ids.retries}>
            If no key or a wrong key
          </label>
          <Select
            id={ids.retries}
            className={FIELD_SELECT}
            value={String(config.retries)}
            disabled={readOnly}
            onChange={(v) => update({ retries: Number(v) })}
            options={RETRY_OPTIONS}
          />
        </div>
      </div>
      <p className="dl-help ivr-help-tight">
        After the last try, the call follows “No key pressed” or “Wrong key”, whichever happened last.
      </p>
      {extras ? (
        <>
          <PromptListField
            label="Wrong-key message (optional)"
            help="Played before asking again, e.g. “Sorry, that isn’t an option.”"
            value={config.invalidPrompts ?? []}
            prompts={prompts}
            onChange={(next) => update({ invalidPrompts: next })}
            forWhat={blockTitle(node)}
            readOnly={readOnly}
            emptyText="None — the menu message simply plays again."
          />
          <PromptListField
            label="No-key message (optional)"
            help="Played before asking again when nothing was pressed."
            value={config.noInputPrompts ?? []}
            prompts={prompts}
            onChange={(next) => update({ noInputPrompts: next })}
            forWhat={blockTitle(node)}
            readOnly={readOnly}
            emptyText="None — the menu message simply plays again."
          />
        </>
      ) : (
        !readOnly && (
          <button type="button" className="vm-linkbtn ivr-linkbtn" onClick={() => setExtras(true)}>
            <Plus size={13} aria-hidden="true" /> Add messages for a wrong key or no key
          </button>
        )
      )}
    </>
  );
}

/* ─── Business hours ──────────────────────────────────────── */

/** "24:00" (end of day) shows as 00:00 in a time input; typed 00:00 as an END means midnight. */
const toInput = (hhmm: string) => (hhmm === '24:00' ? '00:00' : hhmm);
const fromInputEnd = (v: string) => (v === '00:00' ? '24:00' : v);

export function ScheduleForm({ node, config, update, readOnly }: FormProps<'schedule'>) {
  const ids = { tz: useId(), date: useId(), week: useId() };
  const [date, setDate] = useState('');
  const setDay = (day: DayKey, ranges: TimeRange[]) =>
    update({ weekly: { ...config.weekly, [day]: ranges } }, `cfg:${node.id}:hours:${day}`);
  const copyMonday = () => {
    const mon = config.weekly.mon.map((r) => [...r] as TimeRange);
    update({
      weekly: { ...config.weekly, tue: mon.map((r) => [...r] as TimeRange), wed: mon.map((r) => [...r] as TimeRange), thu: mon.map((r) => [...r] as TimeRange), fri: mon.map((r) => [...r] as TimeRange) },
    });
  };
  const addDate = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || config.closedDates.includes(date)) return;
    update({ closedDates: [...config.closedDates, date].sort() });
    setDate('');
  };
  return (
    <>
      <div className="ivr-field">
        <label className="ivr-label" htmlFor={ids.tz}>
          Time zone
        </label>
        <Select<IvrTimezone>
          id={ids.tz}
          className={FIELD_SELECT}
          value={config.tz}
          disabled={readOnly}
          onChange={(tz) => update({ tz })}
          options={TIMEZONE_OPTIONS}
        />
      </div>
      <div className="ivr-field">
        <div className="ivr-label-row">
          <span className="ivr-label" id={ids.week}>
            Open hours
          </span>
          {!readOnly && (
            <button type="button" className="vm-linkbtn ivr-linkbtn" onClick={copyMonday}>
              <Copy size={12} aria-hidden="true" /> Copy Monday to Tue–Fri
            </button>
          )}
        </div>
        <ul className="ivr-week" aria-labelledby={ids.week}>
          {DAY_KEYS.map((day) => {
            const ranges = config.weekly[day] ?? [];
            const open = ranges.length > 0;
            return (
              <li key={day} className={`ivr-day${open ? '' : ' ivr-day-closed'}`}>
                <label className="ivr-day-name">
                  <input
                    type="checkbox"
                    checked={open}
                    disabled={readOnly}
                    onChange={(e) => setDay(day, e.target.checked ? [['09:00', '17:00']] : [])}
                  />
                  {DAY_LABELS[day].short}
                </label>
                <div className="ivr-day-ranges">
                  {!open && <span className="ivr-muted">Closed</span>}
                  {ranges.map(([a, b], i) => (
                    <span key={i} className="ivr-range">
                      <input
                        type="time"
                        className="dl-input ivr-time"
                        aria-label={`${DAY_LABELS[day].long} opens`}
                        value={toInput(a)}
                        disabled={readOnly}
                        onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        type="time"
                        className="dl-input ivr-time"
                        aria-label={`${DAY_LABELS[day].long} closes`}
                        value={toInput(b)}
                        disabled={readOnly}
                        onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? [r[0], fromInputEnd(e.target.value)] : r)))}
                      />
                      {!readOnly && (
                        <button
                          type="button"
                          className="ivr-mini-btn"
                          aria-label={`Remove ${DAY_LABELS[day].long} hours ${i + 1}`}
                          onClick={() => setDay(day, ranges.filter((_, j) => j !== i))}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  ))}
                  {open && !readOnly && ranges.length < LIMITS.rangesPerDay && (
                    <button
                      type="button"
                      className="ivr-mini-btn"
                      aria-label={`Add more ${DAY_LABELS[day].long} hours`}
                      title="Add hours (e.g. a lunch break)"
                      onClick={() => setDay(day, [...ranges, ['13:00', '17:00']])}
                    >
                      <Plus size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="dl-help">Use 00:00 as the closing time for midnight.</p>
      </div>
      <div className="ivr-field">
        <label className="ivr-label" htmlFor={ids.date}>
          Closed all day on
        </label>
        {!readOnly && (
          <div className="ivr-inline-add">
            <input id={ids.date} type="date" className="dl-input" value={date} onChange={(e) => setDate(e.target.value)} />
            <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={addDate} disabled={!date}>
              Add date
            </button>
          </div>
        )}
        {config.closedDates.length === 0 ? (
          <p className="ivr-field-empty">No holidays yet.</p>
        ) : (
          <ul className="ivr-chips">
            {config.closedDates.map((d) => (
              <li key={d} className="ivr-chip">
                <CalendarX2 size={12} aria-hidden="true" />
                {new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                {!readOnly && (
                  <button
                    type="button"
                    className="ivr-chip-x"
                    aria-label={`Remove ${d}`}
                    onClick={() => update({ closedDates: config.closedDates.filter((x) => x !== d) })}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/* ─── Caller check ────────────────────────────────────────── */

export function ConditionForm({ config, update, readOnly }: FormProps<'condition'>) {
  const ids = { mode: useId(), value: useId() };
  const [draft, setDraft] = useState('');
  const mode = config.mode;
  const add = () => {
    if (mode === 'anonymous') return;
    const parts = draft
      .split(/[\s,;]+/)
      .map((p) => normalizeCallerValue(p, mode))
      .filter((p) => p !== '' && !config.values.includes(p));
    if (parts.length === 0) return;
    update({ values: [...config.values, ...parts].slice(0, LIMITS.conditionValues.max) });
    setDraft('');
  };
  const modes: { id: IvrConfigMap['condition']['mode']; label: string }[] = [
    { id: 'prefix', label: 'The caller’s number starts with…' },
    { id: 'equals', label: 'The caller’s number is exactly…' },
    { id: 'anonymous', label: 'The caller withheld their number' },
  ];
  return (
    <>
      <fieldset className="ivr-field ivr-fieldset">
        <legend className="ivr-label">Check whether</legend>
        <div className="ivr-radios">
          {modes.map((m) => (
            <label key={m.id} className={`ivr-radio${mode === m.id ? ' ivr-radio-on' : ''}`}>
              <input
                type="radio"
                name={ids.mode}
                checked={mode === m.id}
                disabled={readOnly}
                onChange={() => update({ mode: m.id })}
              />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
      {mode !== 'anonymous' && (
        <div className="ivr-field">
          <label className="ivr-label" htmlFor={ids.value}>
            {mode === 'prefix' ? 'Number beginnings' : 'Numbers'}
          </label>
          {!readOnly && (
            <div className="ivr-inline-add">
              <input
                id={ids.value}
                className="dl-input ivr-grow"
                inputMode="tel"
                placeholder={mode === 'prefix' ? 'e.g. 617 or +1617' : 'e.g. (617) 555-0234'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={add} disabled={!draft.trim()}>
                Add
              </button>
            </div>
          )}
          {config.values.length === 0 ? (
            <p className="ivr-field-empty">Add at least one. Separate several with commas.</p>
          ) : (
            <ul className="ivr-chips">
              {config.values.map((v) => {
                const problem = callerValueProblem(v, mode);
                return (
                  <li key={v} className={`ivr-chip${problem ? ' ivr-chip-bad' : ''}`} title={problem ?? undefined}>
                    {mode === 'equals' ? fmt(v) : v}
                    {!readOnly && (
                      <button
                        type="button"
                        className="ivr-chip-x"
                        aria-label={`Remove ${v}`}
                        onClick={() => update({ values: config.values.filter((x) => x !== v) })}
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="dl-help">
            {mode === 'prefix' ? 'Area codes work: 617 matches every +1 617 number.' : 'Up to 50 numbers.'}
          </p>
        </div>
      )}
    </>
  );
}

/* ─── Transfer ────────────────────────────────────────────── */

export function DialForm({ node, config, update, readOnly }: FormProps<'dial'>) {
  const data = useBuilderData();
  const ids = { cid: useId(), ring: useId() };
  const [picking, setPicking] = useState(false);
  const t = config.target;
  const own = t.kind === 'own' && t.did ? findOwnNumber(data.destinations, t.did) : null;
  const chosen = t.kind === 'own' ? t.did !== '' : t.number !== '';

  return (
    <>
      <div className="ivr-field">
        <span className="ivr-label">Send the caller to</span>
        <div className={`ivr-destcard${chosen ? '' : ' ivr-destcard-empty'}`}>
          {chosen ? (
            <>
              <span className={`ivr-dest-glyph ivr-dest-glyph--${t.kind === 'own' ? (own?.group.product ?? 'rcf') : 'external'}`}>
                <ProductGlyph product={t.kind === 'own' ? (own?.group.product ?? 'rcf') : 'external'} size={15} />
              </span>
              <span className="ivr-destcard-main">
                <span className="ivr-destcard-name">
                  {t.kind === 'own' ? (own?.number.name ?? 'One of your numbers') : 'Outside number'}
                </span>
                <span className="ivr-destcard-num">{fmt(t.kind === 'own' ? t.did : t.number)}</span>
                {own?.number.detail && <span className="ivr-destcard-detail">{own.number.detail}</span>}
              </span>
            </>
          ) : (
            <span className="ivr-destcard-main">
              <span className="ivr-destcard-name">Not chosen yet</span>
              <span className="ivr-destcard-detail">Pick one of your numbers or an outside US number.</span>
            </span>
          )}
          {!readOnly && (
            <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={() => setPicking(true)}>
              {chosen ? 'Change' : 'Choose…'}
            </button>
          )}
        </div>
      </div>
      <fieldset className="ivr-field ivr-fieldset">
        <legend className="ivr-label">Whoever answers sees</legend>
        <div className="ivr-radios">
          <label className={`ivr-radio${config.passCallerId ? ' ivr-radio-on' : ''}`}>
            <input type="radio" name={ids.cid} checked={config.passCallerId} disabled={readOnly} onChange={() => update({ passCallerId: true })} />
            <span>
              The caller’s number
              <span className="ivr-radio-sub">They know who is calling and can call back.</span>
            </span>
          </label>
          <label className={`ivr-radio${!config.passCallerId ? ' ivr-radio-on' : ''}`}>
            <input type="radio" name={ids.cid} checked={!config.passCallerId} disabled={readOnly} onChange={() => update({ passCallerId: false })} />
            <span>
              This IVR’s number
              <span className="ivr-radio-sub">They can tell the call came through your menu.</span>
            </span>
          </label>
        </div>
      </fieldset>
      <div className="ivr-field">
        <label className="ivr-label" htmlFor={ids.ring}>
          Ring for <strong className="ivr-ring-value">{config.ringTimeoutSec} seconds</strong>
        </label>
        <input
          id={ids.ring}
          type="range"
          className="ivr-range-input"
          min={LIMITS.ringTimeoutSec.min}
          max={LIMITS.ringTimeoutSec.max}
          step={5}
          value={config.ringTimeoutSec}
          disabled={readOnly}
          onChange={(e) => update({ ringTimeoutSec: Number(e.target.value) }, `cfg:${node.id}:ring`)}
          aria-valuetext={`${config.ringTimeoutSec} seconds`}
        />
        <p className="dl-help">
          About {Math.max(1, Math.round(config.ringTimeoutSec / 6))} rings. If nobody answers in time — or the line is
          busy — the call follows <strong>No answer or busy</strong>, below.
        </p>
      </div>
      {picking && (
        <TransferPicker
          value={config.target}
          destinations={data.destinations}
          loading={data.destinationsLoading}
          failed={data.destinationsFailed}
          ownDids={data.ownDids}
          onChoose={(target) => update({ target })}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

/* ─── Voicemail ───────────────────────────────────────────── */

export function VoicemailForm({ config, update, readOnly }: FormProps<'voicemail'>) {
  const data = useBuilderData();
  const ws = useIvrWorkspace();
  const name = useId();
  const boxes = orderedGroups(data.destinations).find((g) => g.product === 'voicemail')?.numbers ?? [];
  if (data.destinationsLoading) return <p className="ivr-state">Loading your mailboxes…</p>;
  if (boxes.length === 0) {
    return (
      <div className="dl-banner dl-banner-warn">
        This account has no voicemail boxes yet.{' '}
        <Link className="vm-linkbtn" to={ws.href('/voicemail')}>
          Set up voicemail
        </Link>
      </div>
    );
  }
  return (
    <fieldset className="ivr-field ivr-fieldset">
      <legend className="ivr-label">Mailbox</legend>
      <div className="ivr-radios">
        {boxes.map((b) => (
          <label key={b.did} className={`ivr-radio${config.did === b.did ? ' ivr-radio-on' : ''}`}>
            <input type="radio" name={name} checked={config.did === b.did} disabled={readOnly} onChange={() => update({ did: b.did })} />
            <span>
              {b.name ?? fmt(b.did)}
              {!b.enabled && <span className="ivr-tag ivr-tag-warn">Switched off</span>}
              <span className="ivr-radio-sub">
                {fmt(b.did)}
                {b.detail ? ` · ${b.detail}` : ''}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className="dl-help">The caller hears that mailbox’s greeting and leaves a message there.</p>
    </fieldset>
  );
}

/* ─── Go to ───────────────────────────────────────────────── */

export function GotoForm({ node, config, update, readOnly }: FormProps<'goto'>) {
  const nodes = useFlow((s) => s.nodes);
  const store = useFlowStoreApi();
  const id = useId();
  const options = useMemo<SelectOption[]>(
    () =>
      nodes
        .filter((n) => n.id !== node.id && n.type !== 'entry' && n.type !== 'goto')
        // The block type rides along as a hint, so two blocks named alike stay apart.
        .map((n) => ({ value: n.id, label: blockTitle(n), hint: n.data.label?.trim() ? BLOCKS[n.type].label : undefined })),
    [nodes, node.id],
  );
  return (
    <div className="ivr-field">
      <label className="ivr-label" htmlFor={id}>
        Go back to
      </label>
      <Select
        id={id}
        className={FIELD_SELECT}
        value={config.targetNodeId}
        disabled={readOnly}
        onChange={(targetNodeId) => update({ targetNodeId })}
        options={options}
        placeholder="Choose a block…"
        searchPlaceholder="Search blocks…"
        emptyText={options.length === 0 ? 'No other blocks yet' : undefined}
      />
      {config.targetNodeId && (
        <button type="button" className="vm-linkbtn ivr-linkbtn" onClick={() => store.getState().focusBlock(config.targetNodeId)}>
          Show that block
        </button>
      )}
      <p className="dl-help">
        For “press 9 to hear the menu again”, point this at the menu. Every call ends after 200 steps or 30 minutes,
        so a loop can never run forever.
      </p>
    </div>
  );
}

/* ─── Hang up ─────────────────────────────────────────────── */

export function HangupForm({ node, config, update, readOnly }: FormProps<'hangup'>) {
  const { prompts } = useBuilderData();
  return (
    <PromptListField
      label="Goodbye message (optional)"
      value={config.prompts ?? []}
      prompts={prompts}
      onChange={(next) => update({ prompts: next })}
      forWhat={blockTitle(node)}
      readOnly={readOnly}
      emptyText="None — the call simply ends."
    />
  );
}
