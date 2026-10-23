/**
 * MailboxSettings — the "Greeting & settings" tab for one mailbox:
 *
 *   Greeting (GreetingsPanel, full width)
 *   Details: name + timezone            Transcription (v1.1, see below)
 *   PIN: set / change (masked)          Storage: messages / space / retention
 *   Administration (staff only): suspend / resume, delete mailbox (typed)
 *
 * Mount KEYED by mailbox id so the forms start from that mailbox's values.
 * Readonly tenants see values, not inputs. No prices anywhere (D5).
 *
 * Transcription — owner decision O2: ONLY a platform admin (`canManage`,
 * incl. "View as Customer") may switch it on/off, change its language or
 * transcribe earlier messages. Tenants (`user` and `readonly`) get a
 * read-only line while it is on, and no panel at all while it is off.
 */
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, KeyRound, PauseCircle, PlayCircle, Trash2 } from 'lucide-react';
import type { Mailbox, MailboxUpdate, TranscriptionLanguage } from '../../types/voicemail';
import { TRANSCRIPTION_LANGUAGES } from '../../types/voicemail';
import { backfillTranscripts, deleteMailbox, setMailboxPin, updateMailbox } from '../../api/voicemail';
import { useToast } from '../../components/ui/ToastContext';
import { invalidateVoicemail, transcriptErrorText, vmErrorText, type VoicemailScope } from './voicemailData';
import { GreetingsPanel } from './GreetingsPanel';
import { ConfirmDialog } from './VmDialog';
import { formatBytes, formatPhone, nationalDigits, PIN_PATTERN, TIMEZONES } from './format';

export interface MailboxSettingsProps {
  scope: VoicemailScope;
  mailbox: Mailbox;
  canEdit: boolean;
  canManage: boolean;
  /** summary.transcription_available. */
  transcriptionAvailable: boolean;
  onDeleted: () => void;
}

export function MailboxSettings({
  scope,
  mailbox,
  canEdit,
  canManage,
  transcriptionAvailable,
  onDeleted,
}: MailboxSettingsProps) {
  // Plan §11.4: shown when transcription is live, or this mailbox already has
  // it on. O2: tenants only while it is on (read-only).
  const transcriptionOn = mailbox.transcription_enabled === true;
  const showTranscription = canManage ? transcriptionAvailable || transcriptionOn : transcriptionOn;
  return (
    <div className="vm-settings">
      <GreetingsPanel scope={scope} mailbox={mailbox} canEdit={canEdit} />
      <DetailsPanel mailbox={mailbox} canEdit={canEdit} />
      {showTranscription && (
        <TranscriptionPanel mailbox={mailbox} canManage={canManage} available={transcriptionAvailable} />
      )}
      <PinPanel mailbox={mailbox} canEdit={canEdit} />
      <StoragePanel mailbox={mailbox} />
      {canManage && <AdminPanel mailbox={mailbox} onDeleted={onDeleted} />}
    </div>
  );
}

/* ─── Details ─────────────────────────────────────────────── */

function DetailsPanel({ mailbox, canEdit }: { mailbox: Mailbox; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { toastOk } = useToast();
  const [label, setLabel] = useState(mailbox.label);
  const [timezone, setTimezone] = useState(mailbox.timezone);
  const labelId = useId();
  const tzId = useId();

  const save = useMutation({
    mutationFn: (body: MailboxUpdate) => updateMailbox(mailbox.id, body),
    onSuccess: () => toastOk('Mailbox details saved.'),
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const trimmed = label.trim();
  const dirty = trimmed !== mailbox.label || timezone !== mailbox.timezone;
  const zones = TIMEZONES.some((z) => z.id === mailbox.timezone)
    ? TIMEZONES
    : [...TIMEZONES, { id: mailbox.timezone, label: mailbox.timezone }];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || trimmed.length === 0) return;
    const body: MailboxUpdate = {};
    if (trimmed !== mailbox.label) body.label = trimmed;
    if (timezone !== mailbox.timezone) body.timezone = timezone;
    save.mutate(body);
  };

  return (
    <section className="dl-panel vm-settings-panel" aria-labelledby={`vm-details-${mailbox.id}`}>
      <div className="dl-panel-head">
        <span id={`vm-details-${mailbox.id}`} className="dl-panel-title">
          Details
        </span>
        <p className="dl-panel-sub">How this mailbox is named and which timezone its messages show in.</p>
      </div>
      {canEdit ? (
        <form className="dl-panel-body vm-form" onSubmit={submit}>
          <div className="vm-field">
            <label className="dl-flabel" htmlFor={labelId}>
              Name
            </label>
            <input
              id={labelId}
              className="dl-input vm-input-full"
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="vm-field">
            <label className="dl-flabel" htmlFor={tzId}>
              Timezone
            </label>
            <select id={tzId} className="dl-input vm-input-full" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.label}
                </option>
              ))}
            </select>
          </div>
          {save.isError && (
            <div className="dl-banner dl-banner-err" role="alert">
              {vmErrorText(save.error, 'The details couldn’t be saved.')}
            </div>
          )}
          <div className="vm-form-actions">
            <button type="submit" className="dl-btn dl-btn-primary vm-btn-sm" disabled={!dirty || trimmed.length === 0 || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </form>
      ) : (
        <div className="dl-panel-body">
          <div className="dl-kv">
            <span className="dl-kv-label">Name</span>
            <span className="dl-kv-value">{mailbox.label}</span>
          </div>
          <div className="dl-kv">
            <span className="dl-kv-label">Timezone</span>
            <span className="dl-kv-value">{zones.find((z) => z.id === mailbox.timezone)?.label ?? mailbox.timezone}</span>
          </div>
        </div>
      )}
    </section>
  );
}

/* ─── Transcription (v1.1) ────────────────────────────────── */

/** Where the audio goes — shown to everyone who sees the panel. */
const TRANSCRIPTION_DISCLOSURE =
  'Transcripts are created by Google Cloud Speech-to-Text in the United States. Audio is sent over an encrypted connection, processed in memory and not kept by Google. Transcripts are encrypted at rest like your recordings and deleted with the message.';

function languageName(id: string | null | undefined): string {
  return TRANSCRIPTION_LANGUAGES.find((l) => l.id === id)?.label ?? id ?? TRANSCRIPTION_LANGUAGES[0].label;
}

function TranscriptionPanel({ mailbox, canManage, available }: { mailbox: Mailbox; canManage: boolean; available: boolean }) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const savedOn = mailbox.transcription_enabled === true;
  const savedLanguage: TranscriptionLanguage = mailbox.transcription_language ?? 'en-US';
  const [on, setOn] = useState(savedOn);
  const [language, setLanguage] = useState<TranscriptionLanguage>(savedLanguage);
  const langId = useId();
  const headId = `vm-tx-${mailbox.id}`;

  const save = useMutation({
    mutationFn: (body: MailboxUpdate) => updateMailbox(mailbox.id, body),
    onSuccess: (_mb, body) => {
      if (body.transcription_enabled === true) toastOk('Transcription is on — new messages will be transcribed.');
      else if (body.transcription_enabled === false) toastOk('Transcription is off for this mailbox.');
      else toastOk('Transcription language saved.');
    },
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const backfill = useMutation({
    mutationFn: () => backfillTranscripts(mailbox.id),
    onSuccess: ({ queued }) =>
      toastOk(
        queued === 0
          ? 'No earlier messages to transcribe.'
          : `Transcribing ${queued} earlier message${queued === 1 ? '' : 's'}.`,
      ),
    onError: (err) => toastErr(transcriptErrorText(err, 'Earlier messages couldn’t be queued. Try again.')),
    onSettled: () => invalidateVoicemail(queryClient),
  });

  // ── Derived (after all hooks) ──
  const dirty = on !== savedOn || language !== savedLanguage;
  const paused = savedOn && !available;
  const languages = TRANSCRIPTION_LANGUAGES.some((l) => l.id === savedLanguage)
    ? TRANSCRIPTION_LANGUAGES
    : [...TRANSCRIPTION_LANGUAGES, { id: savedLanguage, label: savedLanguage }];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || save.isPending) return;
    const body: MailboxUpdate = {};
    if (on !== savedOn) body.transcription_enabled = on;
    if (language !== savedLanguage) body.transcription_language = language;
    save.mutate(body);
  };

  return (
    <section className="dl-panel vm-settings-panel vm-tx-settings" aria-labelledby={headId}>
      <div className="dl-panel-head">
        <span id={headId} className="dl-panel-title">
          Transcription
        </span>
        <span className={`dl-tag${savedOn ? '' : ' dl-tag-slate'}`}>{savedOn ? 'On' : 'Off'}</span>
        <p className="dl-panel-sub">A written transcript next to each new message, so you can read it instead of listening.</p>
      </div>

      {canManage ? (
        <form className="dl-panel-body vm-form" onSubmit={submit}>
          {paused && (
            <div className="dl-banner dl-banner-warn" role="status">
              Transcription is paused.
            </div>
          )}
          <div className="vm-field">
            <span className="dl-flabel" id={`${headId}-switch`}>
              Transcribe new messages
            </span>
            <div className="vm-seg" role="group" aria-labelledby={`${headId}-switch`}>
              <button
                type="button"
                aria-pressed={!on}
                className={`vm-seg-opt${!on ? ' vm-seg-on' : ''}`}
                onClick={() => setOn(false)}
                disabled={save.isPending}
              >
                Off
              </button>
              <button
                type="button"
                aria-pressed={on}
                className={`vm-seg-opt${on ? ' vm-seg-on' : ''}`}
                onClick={() => setOn(true)}
                // Switching on needs transcription live (the API answers 409 otherwise).
                disabled={save.isPending || (!available && !savedOn)}
              >
                On
              </button>
            </div>
          </div>
          <div className="vm-field">
            <label className="dl-flabel" htmlFor={langId}>
              Language
            </label>
            <select
              id={langId}
              className="dl-input vm-input-full"
              value={language}
              onChange={(e) => setLanguage(e.target.value as TranscriptionLanguage)}
              disabled={save.isPending}
            >
              {languages.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <p className="dl-help">{TRANSCRIPTION_DISCLOSURE}</p>
          <p className="dl-help">Only Granite staff can change this setting.</p>
          {save.isError && (
            <div className="dl-banner dl-banner-err" role="alert">
              {transcriptErrorText(save.error, 'The transcription setting couldn’t be saved.')}
            </div>
          )}
          <div className="vm-form-actions">
            <button type="submit" className="dl-btn dl-btn-primary vm-btn-sm" disabled={!dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {savedOn && available && (
            <div className="vm-tx-backfill">
              <div>
                <strong>Earlier messages</strong>
                <p className="dl-help">Transcribes up to 200 of the newest messages that arrived while this was off.</p>
              </div>
              <button
                type="button"
                className="dl-btn dl-btn-ghost vm-btn-sm"
                disabled={backfill.isPending}
                onClick={() => backfill.mutate()}
              >
                {backfill.isPending ? <span className="vm-spin" aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
                Transcribe earlier messages
              </button>
            </div>
          )}
        </form>
      ) : (
        <div className="dl-panel-body">
          {paused && (
            <div className="dl-banner dl-banner-warn vm-gap-bottom" role="status">
              Transcription is paused.
            </div>
          )}
          <div className="dl-kv">
            <span className="dl-kv-label">Transcription</span>
            <span className="dl-kv-value">
              {savedOn ? 'On' : 'Off'} — {languageName(savedLanguage)}
            </span>
          </div>
          <p className="dl-help vm-gap-top">{TRANSCRIPTION_DISCLOSURE}</p>
          <p className="dl-help">Your Granite account team manages this setting.</p>
        </div>
      )}
    </section>
  );
}

/* ─── PIN ─────────────────────────────────────────────────── */

function PinPanel({ mailbox, canEdit }: { mailbox: Mailbox; canEdit: boolean }) {
  const { toastOk } = useToast();
  const queryClient = useQueryClient();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const pinId = useId();
  const confirmId = useId();

  const save = useMutation({
    mutationFn: (value: string) => setMailboxPin(mailbox.id, value),
    onSuccess: () => {
      setPin('');
      setConfirm('');
      toastOk(mailbox.has_pin ? 'PIN changed.' : 'PIN set.');
    },
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const valid = PIN_PATTERN.test(pin);
  const matches = pin === confirm;
  const problem =
    pin.length > 0 && !valid ? 'Use 4 to 10 digits.' : confirm.length > 0 && !matches ? 'The two PINs don’t match.' : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && matches) save.mutate(pin);
  };

  return (
    <section className="dl-panel vm-settings-panel" aria-labelledby={`vm-pin-${mailbox.id}`}>
      <div className="dl-panel-head">
        <span id={`vm-pin-${mailbox.id}`} className="dl-panel-title">
          PIN
        </span>
        <span className={`dl-tag${mailbox.has_pin ? '' : ' dl-tag-slate'}`}>{mailbox.has_pin ? 'Set' : 'Not set'}</span>
        <p className="dl-panel-sub">
          Reserved for phone access to this mailbox, which is coming later. You don’t need it to use this page.
        </p>
      </div>
      {canEdit ? (
        <form className="dl-panel-body vm-form" onSubmit={submit} autoComplete="off">
          <div className="vm-field-row">
            <div className="vm-field">
              <label className="dl-flabel" htmlFor={pinId}>
                {mailbox.has_pin ? 'New PIN' : 'PIN'}
              </label>
              <input
                id={pinId}
                className="dl-input dl-input-mono vm-input-full"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={10}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                aria-invalid={pin.length > 0 && !valid}
              />
            </div>
            <div className="vm-field">
              <label className="dl-flabel" htmlFor={confirmId}>
                Confirm
              </label>
              <input
                id={confirmId}
                className="dl-input dl-input-mono vm-input-full"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={10}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
                aria-invalid={confirm.length > 0 && !matches}
              />
            </div>
          </div>
          <p className={`dl-help${problem ? ' vm-help-err' : ''}`}>{problem ?? '4 to 10 digits. Stored hashed — nobody can read it back.'}</p>
          {save.isError && (
            <div className="dl-banner dl-banner-err" role="alert">
              {vmErrorText(save.error, 'The PIN couldn’t be saved.')}
            </div>
          )}
          <div className="vm-form-actions">
            <button type="submit" className="dl-btn dl-btn-primary vm-btn-sm" disabled={!valid || !matches || save.isPending}>
              <KeyRound size={14} aria-hidden="true" />
              {save.isPending ? 'Saving…' : mailbox.has_pin ? 'Change PIN' : 'Set PIN'}
            </button>
          </div>
        </form>
      ) : (
        <div className="dl-panel-body">
          <p className="dl-help">{mailbox.has_pin ? 'A PIN is set for this mailbox.' : 'No PIN is set.'}</p>
        </div>
      )}
    </section>
  );
}

/* ─── Storage ─────────────────────────────────────────────── */

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const tone = pct >= 90 ? 'vm-meter-bad' : pct >= 75 ? 'vm-meter-warn' : '';
  return (
    <div className="dl-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className={`dl-meter-fill vm-meter-fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StoragePanel({ mailbox }: { mailbox: Mailbox }) {
  const full = mailbox.message_count >= mailbox.max_messages || mailbox.bytes_used >= mailbox.max_bytes;
  return (
    <section className="dl-panel vm-settings-panel" aria-labelledby={`vm-storage-${mailbox.id}`}>
      <div className="dl-panel-head">
        <span id={`vm-storage-${mailbox.id}`} className="dl-panel-title">
          Storage
        </span>
        {full && <span className="dl-pill dl-pill-off">Full</span>}
        <p className="dl-panel-sub">
          {full ? 'This mailbox is full — callers can’t leave new messages until some are deleted.' : 'Limits for this mailbox.'}
        </p>
      </div>
      <div className="dl-panel-body vm-storage">
        <div className="vm-storage-row">
          <div className="vm-storage-top">
            <span>Messages</span>
            <strong>
              {mailbox.message_count} of {mailbox.max_messages}
            </strong>
          </div>
          <Meter value={mailbox.message_count} max={mailbox.max_messages} label="Messages stored" />
        </div>
        <div className="vm-storage-row">
          <div className="vm-storage-top">
            <span>Space (includes Trash)</span>
            <strong>
              {formatBytes(mailbox.bytes_used)} of {formatBytes(mailbox.max_bytes)}
            </strong>
          </div>
          <Meter value={mailbox.bytes_used} max={mailbox.max_bytes} label="Space used" />
        </div>
        <div className="dl-kv">
          <span className="dl-kv-label">Messages are kept for</span>
          <span className="dl-kv-value">{mailbox.retention_days} days</span>
        </div>
        <div className="dl-kv">
          <span className="dl-kv-label">Longest message</span>
          <span className="dl-kv-value">{Math.round(mailbox.max_message_seconds / 60)} minutes</span>
        </div>
      </div>
    </section>
  );
}

/* ─── Administration (staff) ──────────────────────────────── */

function AdminPanel({ mailbox, onDeleted }: { mailbox: Mailbox; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const suspended = mailbox.status === 'suspended';

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'suspended') => updateMailbox(mailbox.id, { status }),
    onSuccess: (_mb, status) =>
      toastOk(status === 'suspended' ? 'Mailbox suspended — callers can’t leave messages.' : 'Mailbox resumed.'),
    onError: (err) => toastErr(vmErrorText(err, 'The status couldn’t be changed.')),
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const remove = useMutation({
    mutationFn: () => deleteMailbox(mailbox.id),
    onSuccess: () => {
      setConfirmDelete(false);
      toastOk(`Mailbox deleted. ${formatPhone(mailbox.did)} is back in the number pool.`);
      onDeleted();
    },
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const digits = nationalDigits(mailbox.did);

  return (
    <section className="dl-panel vm-settings-panel vm-admin-panel" aria-labelledby={`vm-admin-${mailbox.id}`}>
      <div className="dl-panel-head">
        <span id={`vm-admin-${mailbox.id}`} className="dl-panel-title">
          Administration
        </span>
        <span className="vm-staff-tag">Staff</span>
        <p className="dl-panel-sub">Only Granite staff see this section.</p>
      </div>
      <div className="dl-panel-body vm-admin">
        <div className="vm-admin-row">
          <div>
            <strong>{suspended ? 'Suspended' : 'Active'}</strong>
            <p className="dl-help">
              {suspended
                ? 'Callers to this number are turned away. Saved messages stay available here.'
                : 'Callers can leave messages.'}
            </p>
          </div>
          <button
            type="button"
            className="dl-btn dl-btn-ghost vm-btn-sm"
            disabled={setStatus.isPending}
            onClick={() => setStatus.mutate(suspended ? 'active' : 'suspended')}
          >
            {suspended ? <PlayCircle size={14} aria-hidden="true" /> : <PauseCircle size={14} aria-hidden="true" />}
            {suspended ? 'Resume mailbox' : 'Suspend mailbox'}
          </button>
        </div>
        <div className="vm-admin-row">
          <div>
            <strong>Delete mailbox</strong>
            <p className="dl-help">
              Erases every message and greeting and returns {formatPhone(mailbox.did)} to the number pool.
            </p>
          </div>
          <button
            type="button"
            className="dl-btn dl-btn-danger vm-btn-sm"
            onClick={() => {
              remove.reset();
              setConfirmDelete(true);
            }}
          >
            <Trash2 size={14} aria-hidden="true" /> Delete mailbox
          </button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this mailbox?"
          danger
          body={
            <>
              <p>
                <strong>{mailbox.label}</strong> · {formatPhone(mailbox.did)} for {mailbox.customer_name} will be deleted.
              </p>
              <ul className="vm-confirm-list">
                <li>
                  {mailbox.message_count > 0
                    ? `Its ${mailbox.message_count} stored message${mailbox.message_count === 1 ? '' : 's'}, everything in Trash and every greeting are erased.`
                    : 'Everything in Trash and every greeting are erased.'}{' '}
                  This can’t be undone.
                </li>
                <li>The number goes back to the available pool; calls to it stop reaching voicemail.</li>
              </ul>
            </>
          }
          typed={{
            prompt: (
              <>
                Type the mailbox number <span className="vm-mono">{digits}</span> to confirm
              </>
            ),
            placeholder: digits,
            matches: (v) => nationalDigits(v) === digits,
          }}
          confirmLabel="Delete mailbox"
          pending={remove.isPending}
          error={remove.isError ? vmErrorText(remove.error, 'The mailbox couldn’t be deleted.') : null}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}
