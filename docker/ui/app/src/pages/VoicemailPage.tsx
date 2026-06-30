/**
 * VoicemailPage — Visual Voicemail inbox (thin routed page).
 *
 * This is a full-screen master-detail surface: it renders its OWN Sidebar +
 * SoftphoneWidget (outside AppLayout), so per docs/FRONTEND_GLASS_REFACTOR.md §4
 * it mounts its own <GlassBackground> for the ambient blue field + shared
 * keyframes. Everything else is composed from the co-located voicemail/ folder
 * (hooks.ts = data/mutations, styles.ts = glass styles, components/ = surfaces).
 *
 * React #310: every hook is called unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import { GlassBackground } from '../components/glass/GlassBackground';
import { useAuth } from '../contexts/AuthContext';
import { useVoicemailData } from './voicemail/hooks';
import type { Folder } from './voicemail/types';
import { pageRoot, contentShell, readingColumn } from './voicemail/styles';
import { VoicemailRail } from './voicemail/components/VoicemailRail';
import { MessageList } from './voicemail/components/MessageList';
import { ReadingPane } from './voicemail/components/ReadingPane';
import { ReadingEmpty } from './voicemail/components/states';
import { VoicemailSetupWizard } from './voicemail/setup/VoicemailSetupWizard';

export function VoicemailPage() {
  // ── ALL hooks first (React #310) ───────────────────────────────────────────
  const { isAdmin } = useAuth();

  const [customerId, setCustomerId] = useState<number | undefined>(undefined);
  const [mailboxSel, setMailboxId] = useState<number | null>(null);
  const [folder, setFolder] = useState<Folder>('inbox');
  const [search, setSearch] = useState('');
  const [selectedSel, setSelectedId] = useState<number | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const vm = useVoicemailData({ customerId, folder, search, mailboxSel, selectedSel, setSelectedId });

  const noMailbox = vm.mailboxId === null && !vm.mailboxesLoading;

  return (
    <div style={pageRoot}>
      <GlassBackground />
      <Sidebar />

      <div style={contentShell}>
        <VoicemailRail
          mailboxes={vm.mailboxes}
          mailboxId={vm.mailboxId}
          onSelectMailbox={setMailboxId}
          folder={folder}
          onFolder={setFolder}
          counts={vm.folderCounts}
          onNewMailbox={() => setWizardOpen(true)}
          isAdmin={isAdmin}
          customerId={customerId}
          onSelectCustomer={(id) => { setCustomerId(id); setMailboxId(null); setSelectedId(null); }}
        />

        <MessageList
          search={search}
          onSearch={setSearch}
          folder={folder}
          messages={vm.visibleMessages}
          selectedId={vm.selectedId}
          onSelect={setSelectedId}
          loading={vm.messagesLoading}
          noMailbox={noMailbox}
          onCreateMailbox={() => setWizardOpen(true)}
        />

        <section style={readingColumn}>
          {vm.selectedMessage ? (
            <ReadingPane
              key={vm.selectedMessage.id}
              message={vm.selectedMessage}
              detail={vm.detail}
              detailLoading={vm.detailLoading}
              isTrash={folder === 'trash'}
              canCallBack={vm.canCallBack}
              onPlay={vm.actions.onPlay}
              onCallBack={vm.actions.onCallBack}
              onToggleSave={vm.actions.onToggleSave}
              onDelete={vm.actions.onDelete}
              deleting={vm.pending.deleting}
              onRestore={vm.actions.onRestore}
              onPurge={vm.actions.onPurge}
              restoring={vm.pending.restoring}
              purging={vm.pending.purging}
            />
          ) : (
            <ReadingEmpty mailbox={vm.selectedMailbox} />
          )}
        </section>
      </div>

      <SoftphoneWidget />

      <VoicemailSetupWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        customerId={customerId}
        onCreated={(id) => {
          setWizardOpen(false);
          setMailboxId(id);
          setSelectedId(null);
          vm.invalidateMailboxes();
        }}
      />
    </div>
  );
}
