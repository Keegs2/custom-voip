/**
 * AssistPanel — the Flow assistant sheet (docs/IVR_ASSIST_INTERFACES.md §6,
 * §7). In the builder's right column on a desktop, full screen on a phone.
 *
 *   ┌ Flow assistant ─────────────────────────── × ┐
 *   │ Voice for new messages [▾]  What can I say?  │
 *   │ (the keyword guide, when open)               │
 *   │ You: Weekdays 8 to 5 …                       │
 *   │ Flow assistant: Callers hear … [On canvas]   │
 *   │ ◌ Working on it… 12 s                        │
 *   ├──────────────────────────────────────────────┤
 *   │ disclosure (verbatim, above the box)         │
 *   │ [ describe your call flow …              ]   │
 *   │ 0 / 2000                            [Send]   │
 *   └──────────────────────────────────────────────┘
 *
 * All state lives in useFlowAssistant (closing the panel loses nothing).
 * Screen-reader announcements come from AssistAnnouncer, which the builder
 * keeps mounted whether the panel is open or not. React #310: hooks first.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, CircleAlert, MessageCircleQuestion, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { voiceLabel } from '../../pages/ivr/format';
import { prettyNumber } from '../compile/policy';
import { useBuilderData } from '../BuilderData';
import { SideSheet } from '../panels/SideSheet';
import { MESSAGE_MAX_CHARS } from './model';
import { composeBlockedReason, type ProposalTurnState, type Turn } from './conversation';
import { DISCLOSURE } from './guide';
import { KeywordGuide, type GuideNumber } from './KeywordGuide';
import { useAssist } from './useFlowAssistant';

const PRODUCT_WORD: Record<string, string> = {
  rcf: 'Call forwarding',
  voicemail: 'Voicemail',
  ivr: 'IVR',
  trunk: 'SIP trunk',
};

const STATE_TAG: Record<ProposalTurnState, { text: string; tone: string }> = {
  shown: { text: 'On the canvas', tone: 'ivr-tag' },
  accepted: { text: 'Accepted', tone: 'ivr-tag ivr-tag-ok' },
  discarded: { text: 'Discarded', tone: 'ivr-tag ivr-asst-tag-off' },
  replaced: { text: 'Replaced by a newer proposal', tone: 'ivr-tag ivr-asst-tag-off' },
};

/** Seconds since `since`, ticking once a second (purely visual; announcements are separate). */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="ivr-asst-elapsed">{Math.max(0, Math.round((now - since) / 1000))} s</span>;
}

/** The voice new messages are read in (Listen and Accept use it). */
export function VoicePicker({ compact = false }: { compact?: boolean }) {
  const a = useAssist();
  const id = useId();
  if (a.voicesFailed) {
    return <p className="dl-help ivr-asst-voice-off">Text to speech is unavailable right now, so new messages can’t be read aloud.</p>;
  }
  return (
    <div className={`ivr-asst-voice${compact ? ' ivr-asst-voice-compact' : ''}`}>
      <label className="ivr-asst-voice-label" htmlFor={id}>
        {compact ? 'Voice' : 'Voice for new messages'}
      </label>
      <select
        id={id}
        className="dl-input ivr-asst-voice-select"
        value={a.voice}
        onChange={(e) => a.setVoice(e.target.value)}
        disabled={a.voices.length === 0}
      >
        {a.voicesLoading && <option value="">Loading voices…</option>}
        {a.voices.map((v) => (
          <option key={v.id} value={v.id}>
            {voiceLabel(v)}
          </option>
        ))}
      </select>
    </div>
  );
}

function TurnItem({ turn }: { turn: Turn }) {
  switch (turn.who) {
    case 'customer':
      return (
        <li className="ivr-asst-turn ivr-asst-turn-you">
          <span className="ivr-asst-who">You{turn.refining ? ' · changing the proposal' : ''}</span>
          <p className="ivr-asst-text">{turn.text}</p>
        </li>
      );
    case 'error':
      return (
        <li className="ivr-asst-turn ivr-asst-turn-err">
          <span className="ivr-asst-who">
            <CircleAlert size={12} aria-hidden="true" /> Flow assistant
          </span>
          <p className="ivr-asst-text">{turn.text}</p>
        </li>
      );
    case 'assistant': {
      if (turn.kind === 'proposal') {
        const tag = STATE_TAG[turn.state];
        return (
          <li className={`ivr-asst-turn ivr-asst-turn-bot${turn.state === 'shown' ? ' ivr-asst-turn-live' : ''}`}>
            <span className="ivr-asst-who">
              <Sparkles size={12} aria-hidden="true" /> Proposed flow <span className={tag.tone}>{tag.text}</span>
            </span>
            <p className="ivr-asst-text">{turn.text}</p>
          </li>
        );
      }
      return (
        <li className={`ivr-asst-turn ivr-asst-turn-bot${turn.kind === 'cannot_build' ? ' ivr-asst-turn-refusal' : ''}`}>
          <span className="ivr-asst-who">
            {turn.kind === 'clarify' ? (
              <>
                <MessageCircleQuestion size={12} aria-hidden="true" /> A question
              </>
            ) : (
              <>
                <Sparkles size={12} aria-hidden="true" /> Flow assistant
              </>
            )}
          </span>
          <p className="ivr-asst-text">{turn.text}</p>
        </li>
      );
    }
  }
}

export interface AssistPanelProps {
  onClose: () => void;
  /** Phone width: the sheet covers the screen. */
  fullscreen?: boolean;
}

export function AssistPanel({ onClose, fullscreen = false }: AssistPanelProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const a = useAssist();
  const { destinations, ownDids } = useBuilderData();
  const ids = { box: useId(), hint: useId(), count: useId() };
  const s = a.state;
  const [guideOpen, setGuideOpen] = useState(() => s.turns.length === 0);
  const endRef = useRef<HTMLDivElement>(null);
  const { composerRef, focusToken } = a;

  // Keep the newest turn (and the live status) in view — not on a fresh
  // panel, which opens at the top (the guide's title, not its last example).
  useEffect(() => {
    if (s.turns.length === 0 && s.running === null) return;
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [s.turns.length, s.running]);

  // Refine / an example asked for the message box.
  useEffect(() => {
    if (focusToken === 0) return;
    const t = window.setTimeout(() => composerRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [focusToken, composerRef]);

  const numbers = useMemo<GuideNumber[]>(() => {
    const own = new Set(ownDids);
    return (destinations?.groups ?? []).flatMap((g) =>
      g.numbers
        .filter((n) => !own.has(n.did))
        .map((n) => ({ name: n.name?.trim() || prettyNumber(n.did), kind: PRODUCT_WORD[g.product] ?? g.label })),
    );
  }, [destinations, ownDids]);

  // ── Derived (after all hooks) ──
  const blockedReason = composeBlockedReason(s);
  const boxDisabled = s.blocked !== null || s.accepting || (s.proposal !== null && s.refineOf === null);
  const busy = s.sending || s.running !== null;
  const trimmed = a.draft.trim();
  const canSend = a.canCompose && trimmed.length > 0 && trimmed.length <= MESSAGE_MAX_CHARS;

  // Sending folds the guide away so the conversation is what's in view.
  const send = () => {
    setGuideOpen(false);
    a.send();
  };

  const useExample = (text: string) => {
    a.setDraft(text);
    a.requestFocus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSend) send();
    }
  };

  return (
    <SideSheet
      title="Flow assistant"
      sub="Describe your call flow in your own words. It is drawn on the canvas for you to check — nothing changes until you accept."
      icon={<Sparkles size={16} aria-hidden="true" />}
      onClose={onClose}
      fullscreen={fullscreen}
      className="ivr-asst-sheet"
      footer={
        <div className="ivr-asst-composer">
          {s.refineOf && (
            <div className="ivr-asst-refine">
              <span>
                <strong>Changing the proposal.</strong> Say what to change.
              </span>
              <button type="button" className="vm-iconbtn" onClick={a.cancelRefine} aria-label="Stop changing the proposal" title="Cancel">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
          <p className="ivr-asst-disclosure" id={ids.hint}>
            {DISCLOSURE}
          </p>
          <label className="ivr-sr" htmlFor={ids.box}>
            Describe your call flow
          </label>
          <textarea
            ref={composerRef}
            id={ids.box}
            className="dl-input ivr-asst-box"
            rows={fullscreen ? 4 : 3}
            maxLength={MESSAGE_MAX_CHARS}
            value={a.draft}
            disabled={boxDisabled}
            placeholder={
              s.refineOf
                ? 'For example: make 2 go to the billing line instead.'
                : 'For example: weekdays 8 to 5 Eastern, press 1 for billing, 2 to report an outage…'
            }
            onChange={(e) => a.setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            aria-describedby={`${ids.hint} ${ids.count}`}
            data-autofocus={boxDisabled ? undefined : true}
          />
          <div className="ivr-asst-compose-row">
            <span className="ivr-asst-count" id={ids.count}>
              {trimmed.length.toLocaleString()} / {MESSAGE_MAX_CHARS.toLocaleString()}
              <span className="ivr-asst-keys" aria-hidden="true">
                {' '}
                · ⌘/Ctrl + Enter sends
              </span>
            </span>
            <button type="button" className="dl-btn dl-btn-primary ivr-btn-sm" disabled={!canSend} onClick={send}>
              {s.sending ? <span className="vm-spin vm-spin-light" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
              {s.refineOf ? 'Send change' : 'Send'}
            </button>
          </div>
          {blockedReason && <p className="ivr-asst-hint">{blockedReason}</p>}
          {s.notice && !s.blocked && (
            <p className="ivr-asst-notice">
              <CircleAlert size={13} aria-hidden="true" /> {s.notice}
            </p>
          )}
        </div>
      }
    >
      {s.turns.length === 0 && !busy && (
        <div className="ivr-asst-empty">
          <p className="ivr-asst-empty-title">Tell it how calls should go</p>
          <p className="ivr-asst-empty-copy">
            Opening hours, a menu of options, who to ring and what happens if nobody answers. You see the result on the
            canvas first — accept it, ask for changes, or discard it.
          </p>
        </div>
      )}

      <div className="ivr-asst-tools">
        <VoicePicker />
        <div className="ivr-asst-toolbtns">
          <button
            type="button"
            className={`ivr-preset ivr-asst-guide-btn${guideOpen ? ' ivr-asst-guide-on' : ''}`}
            aria-expanded={guideOpen}
            onClick={() => setGuideOpen((o) => !o)}
          >
            <BookOpen size={13} aria-hidden="true" /> What can I say?
          </button>
          {s.turns.length > 0 && (
            <button
              type="button"
              className="vm-linkbtn ivr-linkbtn"
              onClick={a.reset}
              disabled={busy || s.proposal !== null}
              title={s.proposal ? 'Accept or discard the proposal first' : undefined}
            >
              <RotateCcw size={12} aria-hidden="true" /> Start over
            </button>
          )}
        </div>
      </div>

      {guideOpen && (
        <KeywordGuide onUseExample={useExample} examplesDisabled={boxDisabled} numbers={numbers} />
      )}

      {s.turns.length > 0 && (
        <ol className="ivr-asst-log" aria-label="Conversation with the flow assistant">
          {s.turns.map((t) => (
            <TurnItem key={t.id} turn={t} />
          ))}
        </ol>
      )}

      {busy && (
        <p className="ivr-asst-status">
          <span className="vm-spin" aria-hidden="true" />
          <span>{s.sending ? 'Sending…' : 'Drafting your flow…'}</span>
          {s.running && <Elapsed since={s.running.startedAt} />}
        </p>
      )}
      <div ref={endRef} />
    </SideSheet>
  );
}

/**
 * The polite live region for everything the assistant does (sent, working,
 * proposal ready, a question, an error, accepted, discarded). Mounted by the
 * builder for as long as the assistant is available, so a status is read
 * out even when the panel is closed. Keyed by `announceSeq` so the same
 * words twice are still announced.
 */
export function AssistAnnouncer() {
  const a = useAssist();
  return (
    <div className="ivr-sr" role="status" aria-live="polite" aria-atomic="true">
      <span key={a.state.announceSeq}>{a.state.announcement}</span>
    </div>
  );
}
