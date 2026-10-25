/**
 * IvrDialogs — the small dialogs of the /ivr page: name a thing (new flow,
 * rename a flow / number / message) and choose the flow a number answers
 * with. Built on the shared VmDialog (portal, focus trap, Esc, themed).
 */
import { useId, useState, type ReactNode } from 'react';
import type { FlowSummary, IvrNumber } from '../../types/ivr';
import { VmDialog } from '../voicemail/VmDialog';
import { fmt } from '../../utils/format';

/* ─── Name ────────────────────────────────────────────────── */

export interface NameDialogProps {
  title: string;
  sub?: ReactNode;
  label: string;
  initial: string;
  confirmLabel: string;
  pendingLabel: string;
  maxLength?: number;
  pending: boolean;
  error: string | null;
  /** Allow saving an empty value (a number's name is optional). */
  allowEmpty?: boolean;
  placeholder?: string;
  /** Only enable Save once the value differs from `initial` (renames). */
  requireChange?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export function NameDialog({
  title,
  sub,
  label,
  initial,
  confirmLabel,
  pendingLabel,
  maxLength = 100,
  pending,
  error,
  allowEmpty = false,
  placeholder,
  requireChange = true,
  onSubmit,
  onClose,
}: NameDialogProps) {
  const [value, setValue] = useState(initial);
  const id = useId();
  const trimmed = value.trim();
  const canSave = !pending && (allowEmpty || trimmed.length > 0) && (!requireChange || trimmed !== initial.trim());

  return (
    <VmDialog
      title={title}
      sub={sub}
      onClose={onClose}
      busy={pending}
      width={460}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" form={`${id}-form`} className="dl-btn dl-btn-primary" disabled={!canSave}>
            {pending && <span className="vm-spin vm-spin-light" aria-hidden="true" />}
            {pending ? pendingLabel : confirmLabel}
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) onSubmit(trimmed);
        }}
      >
        <div className="vm-field">
          <label className="ivr-label" htmlFor={id}>
            {label}
          </label>
          <input
            id={id}
            className="dl-input vm-input-full"
            value={value}
            maxLength={maxLength}
            placeholder={placeholder}
            autoComplete="off"
            onChange={(e) => setValue(e.target.value)}
            data-autofocus
          />
        </div>
      </form>
      {error && (
        <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
          {error}
        </div>
      )}
    </VmDialog>
  );
}

/* ─── Bind a flow to a number ─────────────────────────────── */

export interface BindFlowDialogProps {
  number: IvrNumber;
  flows: readonly FlowSummary[];
  pending: boolean;
  error: string | null;
  onSubmit: (flowId: number | null) => void;
  onClose: () => void;
}

export function BindFlowDialog({ number, flows, pending, error, onSubmit, onClose }: BindFlowDialogProps) {
  const [choice, setChoice] = useState<number | null>(number.flow_id);
  const groupId = useId();
  const chosen = flows.find((f) => f.id === choice) ?? null;
  const changed = choice !== number.flow_id;

  return (
    <VmDialog
      title="Choose the flow callers hear"
      sub={
        <>
          For <strong>{number.name ? `${number.name} · ` : ''}{fmt(number.did)}</strong>.
        </>
      }
      onClose={onClose}
      busy={pending}
      width={520}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-primary"
            disabled={!changed || pending}
            onClick={() => onSubmit(choice)}
          >
            {pending && <span className="vm-spin vm-spin-light" aria-hidden="true" />}
            {pending ? 'Saving…' : choice === null ? 'Remove the flow' : 'Use this flow'}
          </button>
        </>
      }
    >
      <div role="radiogroup" aria-labelledby={`${groupId}-label`} className="ivr-choice-list">
        <span id={`${groupId}-label`} className="ivr-sr">
          Flows
        </span>
        {flows.map((f) => (
          <label key={f.id} className={`ivr-choice${choice === f.id ? ' ivr-choice-on' : ''}`}>
            <input
              type="radio"
              name={groupId}
              checked={choice === f.id}
              onChange={() => setChoice(f.id)}
              data-autofocus={choice === f.id ? true : undefined}
            />
            <span className="ivr-choice-main">
              <span className="ivr-choice-name">{f.name}</span>
              <span className="ivr-choice-detail">
                {f.published_version ? `Published · version ${f.published_version}` : 'Not published yet'}
                {f.numbers.length > 0 && f.numbers.some((d) => d !== number.did)
                  ? ` · also on ${f.numbers.filter((d) => d !== number.did).map(fmt).join(', ')}`
                  : ''}
              </span>
            </span>
          </label>
        ))}
        <label className={`ivr-choice${choice === null ? ' ivr-choice-on' : ''}`}>
          <input type="radio" name={groupId} checked={choice === null} onChange={() => setChoice(null)} />
          <span className="ivr-choice-main">
            <span className="ivr-choice-name">No flow</span>
            <span className="ivr-choice-detail">Calls to this number are turned away.</span>
          </span>
        </label>
      </div>
      {chosen && !chosen.published_version && (
        <div className="dl-banner dl-banner-warn vm-gap-top">
          “{chosen.name}” isn’t published yet. Calls are turned away until you publish it.
        </div>
      )}
      {error && (
        <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
          {error}
        </div>
      )}
    </VmDialog>
  );
}
