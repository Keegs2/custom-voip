/**
 * ProposalBanner — what the Flow assistant proposes, above the read-only
 * canvas (docs/IVR_ASSIST_INTERFACES.md §7): the summary, the assumptions,
 * the new messages (each with Listen, read in the chosen voice), anything
 * the server's check still flags, and the four choices — Accept, Refine,
 * Discard, Try a test call. The draft is untouched until Accept.
 *
 * `docked` sits at the top of the desktop canvas column (the canvas shrinks
 * below it; the details collapse — and do so by themselves when a test call
 * opens, so its steps stay in view); `inline` sits above the phone diagram.
 */
import { useId, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FlaskConical,
  PenLine,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Volume2,
} from 'lucide-react';
import type { Issue } from '../../types/ivr';
import { useIvrWorkspace } from '../../pages/ivr/IvrContext';
import { plural } from '../../pages/ivr/format';
import { useFlow, useFlowStoreApi } from '../store/flowStore';
import { blockTitle } from '../model/summary';
import { usedNewPrompts, type ProposalChanges } from './model';
import { useAssist } from './useFlowAssistant';
import { useListen } from './useListen';
import { VoicePicker } from './AssistPanel';

export interface ProposalBannerProps {
  variant: 'docked' | 'inline';
  changes: ProposalChanges | null;
  onRefine: () => void;
  onTestCall: () => void;
}

export function ProposalBanner({ variant, changes, onRefine, onTestCall }: ProposalBannerProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const a = useAssist();
  const ws = useIvrWorkspace();
  const store = useFlowStoreApi();
  const overlay = useFlow((s) => s.proposal);
  const listen = useListen(ws.scope.customerId);
  const [open, setOpen] = useState(true);
  const headId = useId();
  const bodyId = useId();
  const shown = a.state.proposal;
  const result = shown?.result ?? null;
  const messages = useMemo(() => (result ? usedNewPrompts(result) : []), [result]);
  const titles = useMemo(() => new Map((overlay?.nodes ?? []).map((n) => [n.id, blockTitle(n)])), [overlay]);

  if (!shown || !result) return null;

  // ── Derived (after all hooks) ──
  const accepting = a.state.accepting;
  const noVoice = messages.length > 0 && a.voice === '';
  const blocks = overlay?.nodes.length ?? result.draft_graph.nodes.length;
  const counts = [
    plural(blocks, 'block'),
    changes && changes.added ? `${changes.added} new` : null,
    changes && changes.changed ? `${changes.changed} changed` : null,
    changes && changes.removed ? `${changes.removed} removed` : null,
    messages.length ? plural(messages.length, 'new message') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const jump = (id: string | null | undefined) => {
    if (id && titles.has(id)) store.getState().revealBlock(id);
  };
  const issueList = (list: readonly Issue[], tone: 'error' | 'warning') => (
    <ul className="ivr-issues">
      {list.map((i, n) => (
        <li key={n} className={`ivr-issue ivr-issue-${tone}`}>
          <button type="button" className="ivr-issue-btn" onClick={() => jump(i.node_id)} disabled={!i.node_id || !titles.has(i.node_id)}>
            {tone === 'error' ? (
              <CircleAlert size={14} className="ivr-issue-ic" aria-hidden="true" />
            ) : (
              <TriangleAlert size={14} className="ivr-issue-ic" aria-hidden="true" />
            )}
            <span>
              {i.node_id && titles.has(i.node_id) && <strong className="ivr-issue-where">{titles.get(i.node_id)}: </strong>}
              {i.message}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <section className={`ivr-prop ivr-prop--${variant}`} aria-labelledby={headId}>
      <div className="ivr-prop-head">
        <span className="ivr-prop-icon" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <div className="ivr-prop-titles">
          <h2 id={headId} className="ivr-prop-title">
            Proposed flow
          </h2>
          <p className="ivr-prop-meta">
            {counts} · read-only, your draft is unchanged
          </p>
        </div>
        {variant === 'docked' && (
          <button
            type="button"
            className="vm-iconbtn"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((o) => !o)}
            title={open ? 'Hide the details' : 'Show the details'}
          >
            {open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
            <span className="ivr-sr">{open ? 'Hide the details' : 'Show the details'}</span>
          </button>
        )}
      </div>

      {(open || variant === 'inline') && (
        <div className="ivr-prop-body" id={bodyId}>
          {result.summary && <p className="ivr-prop-summary">{result.summary}</p>}

          {result.assumptions.length > 0 && (
            <div className="ivr-prop-part">
              <h3 className="ivr-prop-h">What it assumed</h3>
              <ul className="ivr-prop-assume">
                {result.assumptions.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}

          {messages.length > 0 && (
            <div className="ivr-prop-part">
              <div className="ivr-prop-h-row">
                <h3 className="ivr-prop-h">New messages</h3>
                <VoicePicker compact />
              </div>
              <ul className="ivr-prop-msgs">
                {messages.map((m) => {
                  const key = String(m.placeholder_id);
                  const isPlaying = listen.playing === key;
                  const isLoading = listen.loading === key;
                  return (
                    <li key={key} className="ivr-prop-msg">
                      <div className="ivr-prop-msg-main">
                        <span className="ivr-prop-msg-name">{m.name}</span>
                        <span className="ivr-prop-msg-text">{m.text}</span>
                        {listen.failure?.key === key && (
                          <span className="ivr-prop-msg-err" role="alert">
                            {listen.failure.text}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="dl-btn dl-btn-ghost ivr-btn-sm ivr-prop-listen"
                        onClick={() => listen.toggle(key, m.text, a.voice)}
                        disabled={a.voice === '' && !isPlaying}
                        aria-pressed={isPlaying}
                        aria-label={`${isPlaying ? 'Stop' : 'Listen to'} “${m.name}”`}
                      >
                        {isLoading ? (
                          <span className="vm-spin" aria-hidden="true" />
                        ) : isPlaying ? (
                          <Square size={12} aria-hidden="true" />
                        ) : (
                          <Volume2 size={13} aria-hidden="true" />
                        )}
                        {isPlaying ? 'Stop' : 'Listen'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="dl-help">These are made as new messages when you accept.</p>
            </div>
          )}

          {result.issues.length > 0 && (
            <div className="ivr-prop-part">
              <h3 className="ivr-prop-h">Still to fix after you accept</h3>
              {issueList(result.issues, 'error')}
            </div>
          )}
          {result.warnings.length > 0 && (
            <div className="ivr-prop-part">
              <h3 className="ivr-prop-h">Worth a look</h3>
              {issueList(result.warnings, 'warning')}
            </div>
          )}
        </div>
      )}

      {a.state.acceptError && (
        <div className="dl-banner dl-banner-err ivr-prop-err" role="alert">
          {a.state.acceptError}
        </div>
      )}
      {noVoice && !a.voicesLoading && (
        <p className="ivr-prop-note">Text to speech is unavailable, so the new messages can’t be made yet.</p>
      )}

      <div className="ivr-prop-actions">
        <button type="button" className="dl-btn dl-btn-primary ivr-btn-sm" onClick={a.accept} disabled={accepting || noVoice}>
          {accepting ? <span className="vm-spin vm-spin-light" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          {accepting ? 'Accepting…' : a.state.acceptError ? 'Try again' : 'Accept'}
        </button>
        <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={onRefine} disabled={accepting}>
          <PenLine size={13} aria-hidden="true" /> Refine
        </button>
        <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={a.discard} disabled={accepting}>
          <Trash2 size={13} aria-hidden="true" /> Discard
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost ivr-btn-sm"
          onClick={() => {
            if (variant === 'docked') setOpen(false);
            onTestCall();
          }}
          disabled={accepting}
        >
          <FlaskConical size={13} aria-hidden="true" /> Try a test call
        </button>
      </div>
    </section>
  );
}
