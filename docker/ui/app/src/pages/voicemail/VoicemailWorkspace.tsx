/**
 * VoicemailWorkspace — the Visual Voicemail product page body, shared by
 * every audience (tenant, admin "View as Customer" preview, admin console).
 * The route entry (pages/VisualVoicemailPage.tsx) decides the scope and the
 * abilities; this component never reads `user.customer_id`.
 *
 *   ┌ CompactHeader (one row): crumb · Voicemail [Encrypted at rest]   [Viewing ▾]  Unread | Messages | Mailboxes  [+ New mailbox] ┐
 *   ┌ mailbox bar (one slim row): Mailbox [Front desk ▾]          (617) 555-0134 · Active ┐
 *   [ Messages | Greeting & settings ]                                           (tab rail)
 *   InboxView (MasterDetail: list | reading pane)  |  MailboxSettings
 *
 * Layout follows docker/ui/CLAUDE.md §20 (layout kit).
 *
 * States: loading, error (503 → "temporarily unavailable"), a tenant whose
 * voicemail isn't switched on (VoicemailIntro), no mailboxes (staff get the
 * New mailbox call to action), suspended-mailbox banner.
 *
 * Transcription (v1.1): `summary.transcription_available` (platform flag on
 * and configured) is read once here and handed down. Who may switch it on is
 * `canManage` — platform admins only, incl. "View as Customer" (owner
 * decision O2); tenants see it read-only.
 */
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { Mailbox } from '../../types/voicemail';
import { IconVoicemail } from '../../components/icons/ProductIcons';
import { Spinner } from '../../components/ui/Spinner';
import { Select, type SelectOption } from '../../components/ui/Select';
import { isUnavailable, UNAVAILABLE_TEXT, useMailboxes, useVoicemailSummary, type VoicemailScope } from './voicemailData';
import { InboxView } from './InboxView';
import { MailboxSettings } from './MailboxSettings';
import { NewMailboxDialog } from './NewMailboxDialog';
import { EncryptionBadge } from './EncryptionBadge';
import { VoicemailIntro } from './VoicemailIntro';
import { formatPhone } from './format';
import { CompactHeader, type HeaderStat } from '../../components/layout/kit';
import { ApiError } from '../../api/client';

type Tab = 'messages' | 'settings';

export interface VoicemailWorkspaceProps {
  scope: VoicemailScope;
  viewer: 'tenant' | 'preview' | 'admin';
  /** May change messages, greetings, label, PIN. */
  canEdit: boolean;
  /** Staff: may create, suspend and delete mailboxes. */
  canManage: boolean;
  /** Breadcrumb tail (customer name, "Staff console"). */
  crumb: string;
  /** Amber staff tag in the header ("Staff preview", "Staff"), or null. */
  tag: string | null;
  /** Who a new mailbox is for (null = pick in the dialog). */
  createFor: { id: number; name: string } | null;
  /** Show the owning customer next to mailboxes (admin, all customers). */
  showCustomer: boolean;
  /** Extra header tools (the admin scope picker). */
  tools?: ReactNode;
}

function sumOf(list: readonly Mailbox[], pick: (m: Mailbox) => number): number {
  return list.reduce((n, m) => n + pick(m), 0);
}

export function VoicemailWorkspace({
  scope,
  viewer,
  canEdit,
  canManage,
  crumb,
  tag,
  createFor,
  showCustomer,
  tools,
}: VoicemailWorkspaceProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const summary = useVoicemailSummary(scope);
  const mailboxes = useMailboxes(scope);
  const [mailboxSel, setMailboxSel] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('messages');
  const [creating, setCreating] = useState(false);
  const selectId = useId();

  const list = useMemo(() => mailboxes.data ?? [], [mailboxes.data]);
  // The user's pick if it still exists, else the first mailbox — derived, so
  // a deleted mailbox or a scope switch falls back without an effect.
  const mailbox = list.find((m) => m.id === mailboxSel) ?? list[0] ?? null;

  // One row per mailbox: "Front desk · (617) 555-0134", with "3 new" / "Suspended"
  // as the dimmer hint. All customers: grouped under each customer's name
  // (consecutive rows sharing a `group`), which is searchable too.
  const mailboxOptions = useMemo<SelectOption[]>(() => {
    const ordered = showCustomer
      ? [...list].sort((a, b) => a.customer_name.localeCompare(b.customer_name) || a.label.localeCompare(b.label))
      : list;
    return ordered.map((m) => {
      const customerName = m.customer_name || `Customer #${m.customer_id}`;
      const notes = [m.unread_count > 0 ? `${m.unread_count} new` : '', m.status === 'suspended' ? 'Suspended' : ''];
      return {
        value: String(m.id),
        label: `${m.label} · ${formatPhone(m.did)}`,
        hint: notes.filter(Boolean).join(' · ') || undefined,
        keywords: `${m.did}${showCustomer ? ` ${customerName}` : ''}`,
        group: showCustomer ? customerName : undefined,
      };
    });
  }, [list, showCustomer]);

  const onCreated = useCallback((mb: Mailbox) => {
    setCreating(false);
    setMailboxSel(mb.id);
    setTab('messages');
  }, []);

  const onDeleted = useCallback(() => {
    setMailboxSel(null);
    setTab('messages');
  }, []);

  const openSettings = useCallback(() => setTab('settings'), []);

  // ── Derived (after all hooks) ──
  const transcriptionAvailable = summary.data?.transcription_available === true;
  const unread = sumOf(list, (m) => m.unread_count);
  const stored = sumOf(list, (m) => m.message_count);
  const ready = mailboxes.isSuccess;
  const tenantOff =
    viewer === 'tenant' &&
    list.length === 0 &&
    (summary.data?.enabled === false || (summary.error instanceof ApiError && summary.error.status === 404));

  let body: ReactNode;
  // A tenant with no mailboxes needs the summary too (intro vs. empty).
  if (mailboxes.isLoading || (viewer === 'tenant' && list.length === 0 && summary.isLoading)) {
    body = (
      <div className="dl-panel">
        <div className="dl-center" role="status">
          <Spinner size="lg" />
          <span className="dl-help">Loading voicemail…</span>
        </div>
      </div>
    );
  } else if (tenantOff) {
    body = <VoicemailIntro transcriptionAvailable={transcriptionAvailable} />;
  } else if (mailboxes.isError) {
    const unavailable = isUnavailable(mailboxes.error);
    body = (
      <div className="dl-panel">
        <div className="dl-center" role="alert">
          <span className="dl-center-icon" aria-hidden="true">
            <IconVoicemail size={26} />
          </span>
          <strong className="vm-center-title">
            {unavailable ? 'Voicemail is temporarily unavailable' : 'Voicemail couldn’t load'}
          </strong>
          <p className="vm-center-copy">
            {unavailable ? UNAVAILABLE_TEXT.replace('Voicemail is temporarily unavailable. ', '') : 'Something went wrong loading your mailboxes.'}
          </p>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={() => void mailboxes.refetch()} disabled={mailboxes.isFetching}>
            <RefreshCw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      </div>
    );
  } else if (list.length === 0) {
    body = (
      <div className="dl-panel">
        <div className="dl-center">
          <span className="dl-center-icon" aria-hidden="true">
            <IconVoicemail size={26} />
          </span>
          <strong className="vm-center-title">No voicemail mailboxes yet</strong>
          <p className="vm-center-copy">
            {canManage
              ? createFor
                ? `Give ${createFor.name} a voicemail number: pick one from the pool and it rings straight to a mailbox.`
                : 'Create a mailbox for any customer: pick a number from the pool and it rings straight to voicemail.'
              : 'Your Granite account team sets up voicemail numbers. Once one is on your account, its messages show up here.'}
          </p>
          {canManage && (
            <button type="button" className="dl-btn dl-btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} aria-hidden="true" /> New mailbox
            </button>
          )}
        </div>
      </div>
    );
  } else if (mailbox) {
    body = (
      <>
        <div className="dl-panel vm-mbar">
          <div className="vm-mbar-pick">
            <label className="dl-flabel" htmlFor={selectId}>
              Mailbox
            </label>
            {list.length > 1 ? (
              <Select
                id={selectId}
                className="dl-input vm-mbar-select"
                value={String(mailbox.id)}
                onChange={(v) => setMailboxSel(Number(v))}
                options={mailboxOptions}
                searchPlaceholder="Search mailboxes…"
              />
            ) : (
              <span id={selectId} className="vm-mbar-single">
                {mailbox.label}
              </span>
            )}
          </div>
          <div className="vm-mbar-facts">
            <span className="dl-chip">{formatPhone(mailbox.did)}</span>
            {showCustomer && <span className="vm-mbar-customer">{mailbox.customer_name}</span>}
            <span className={`dl-pill ${mailbox.status === 'active' ? 'dl-pill-on' : 'dl-pill-off'}`}>
              {mailbox.status === 'active' ? 'Active' : 'Suspended'}
            </span>
          </div>
        </div>

        {mailbox.status === 'suspended' && (
          <div className="dl-banner dl-banner-warn vm-gap-bottom" role="status">
            This mailbox is suspended — callers can’t leave new messages. Existing messages are still here.
          </div>
        )}

        <div className="dl-tabs vm-tabs" role="tablist" aria-label="Mailbox">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'messages'}
            className={`dl-tab${tab === 'messages' ? ' dl-tab-active' : ''}`}
            onClick={() => setTab('messages')}
          >
            Messages
            {mailbox.unread_count > 0 && <span className="dl-count">{mailbox.unread_count} new</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'settings'}
            className={`dl-tab${tab === 'settings' ? ' dl-tab-active' : ''}`}
            onClick={() => setTab('settings')}
          >
            Greeting &amp; settings
          </button>
        </div>

        {tab === 'messages' ? (
          <InboxView
            key={`inbox-${mailbox.id}`}
            scope={scope}
            mailbox={mailbox}
            canEdit={canEdit}
            canManage={canManage}
            transcriptionAvailable={transcriptionAvailable}
            onOpenSettings={openSettings}
          />
        ) : (
          <MailboxSettings
            key={`settings-${mailbox.id}`}
            scope={scope}
            mailbox={mailbox}
            canEdit={canEdit}
            canManage={canManage}
            transcriptionAvailable={transcriptionAvailable}
            onDeleted={onDeleted}
          />
        )}
      </>
    );
  }

  const stats: HeaderStat[] | undefined =
    ready && list.length > 0
      ? [
          { label: 'Unread', value: unread },
          { label: 'Messages', value: stored },
          { label: list.length === 1 ? 'Mailbox' : 'Mailboxes', value: list.length },
        ]
      : undefined;

  return (
    <div className="dl-scope vm-scope">
      <div className="dl-shell vm-shell">
        <CompactHeader
          className="vm-header fx-load"
          crumb={
            <>
              <span>Visual Voicemail</span>
              <span className="dl-crumb-sep" aria-hidden="true">
                /
              </span>
              <span className="vm-crumb-tail">{crumb}</span>
              {tag && <span className="vm-staff-tag">{tag}</span>}
            </>
          }
          title="Voicemail"
          titleAside={<EncryptionBadge />}
          subtitle="Listen to messages, set your greeting, and keep every mailbox tidy — from any browser."
          tools={tools}
          stats={stats}
          statsLabel="Voicemail totals"
          actions={
            canManage && ready && list.length > 0 ? (
              <button type="button" className="dl-btn dl-btn-primary vm-btn-sm" onClick={() => setCreating(true)}>
                <Plus size={14} aria-hidden="true" /> New mailbox
              </button>
            ) : undefined
          }
        />

        <div className="vm-body fx-load fx-load-d1">{body}</div>
      </div>

      {creating && (
        <NewMailboxDialog
          customer={createFor}
          transcriptionAvailable={transcriptionAvailable}
          onClose={() => setCreating(false)}
          onCreated={onCreated}
        />
      )}
    </div>
  );
}
