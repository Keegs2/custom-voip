/**
 * User360View — the full single-user detail view. Composes the header, optional
 * edit panel, stat tiles, extension/devices, recent calls, per-product tables
 * and quick actions. Data + edit-toggle state come from hooks; this file is
 * composition + spacing only.
 *
 * React #310: the query + editing hooks are called unconditionally at the top.
 */

import { GLASS } from '../../../../components/glass/glass';
import { useUser360, useUser360Editing } from '../hooks';
import { SectionCard } from './SectionCard';
import { HeaderCard } from './HeaderCard';
import { EditUserPanel } from './EditUserPanel';
import { StatusGrid } from './StatusGrid';
import { ExtensionConfigCard } from './ExtensionConfigCard';
import { DevicesCard } from './DevicesCard';
import { RecentCallsCard } from './RecentCallsCard';
import { RcfCard, ApiDidCard, TrunksCard } from './ProductCards';
import { QuickActions } from './QuickActions';
import { LoadingState, ErrorState } from './states';
import { IconInfo } from './icons';

interface User360ViewProps {
  userId: number;
}

export function User360View({ userId }: User360ViewProps) {
  const { data, isLoading, isError, error } = useUser360(userId);
  const { isEditing, setIsEditing, handleEditSuccess } = useUser360Editing(userId);

  if (isLoading) return <LoadingState label="Loading user details…" />;
  if (isError) {
    return <ErrorState title="Failed to load user details" message={error instanceof Error ? error.message : 'Unknown error'} />;
  }
  if (!data) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <HeaderCard data={data} isEditing={isEditing} onEditToggle={() => setIsEditing((prev) => !prev)} />

      {isEditing && (
        <EditUserPanel userId={userId} user={data.user} onSuccess={handleEditSuccess} onCancel={() => setIsEditing(false)} />
      )}

      <StatusGrid data={data} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
        {data.extension ? (
          <ExtensionConfigCard extension={data.extension} />
        ) : (
          <SectionCard accent={GLASS.textFaint} title="Extension Configuration" icon={<IconInfo />}>
            <div style={{ color: GLASS.textMuted, fontSize: '0.82rem', fontStyle: 'italic', padding: '8px 0' }}>
              No extension assigned to this user.
            </div>
          </SectionCard>
        )}

        <DevicesCard devices={data.devices} />
      </div>

      <RecentCallsCard calls={data.recent_calls} />

      {data.products.rcf.length > 0 && <RcfCard rcf={data.products.rcf} />}
      {data.products.api_dids.length > 0 && <ApiDidCard api_dids={data.products.api_dids} />}
      {data.products.trunks.length > 0 && <TrunksCard trunks={data.products.trunks} />}

      <QuickActions data={data} />
    </div>
  );
}
