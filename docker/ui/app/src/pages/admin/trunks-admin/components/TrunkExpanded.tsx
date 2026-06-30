/**
 * TrunkExpanded — the inline detail revealed when a trunk row is expanded:
 * edit/delete actions, an optional edit form, and the IP / DID / connection
 * three-column layout. Owns only the local "is editing" toggle.
 */

import { useState } from 'react';
import { Button } from '../../../../components/ui/Button';
import type { Trunk } from '../../../../types/trunk';
import { IpSection } from './IpSection';
import { DidSection } from './DidSection';
import { ConnectionInfo } from './ConnectionInfo';
import { EditTrunkForm } from './EditTrunkForm';
import { expandedShell } from '../styles';

interface TrunkExpandedProps {
  trunk: Trunk;
  onDelete: () => void;
}

export function TrunkExpanded({ trunk, onDelete }: TrunkExpandedProps) {
  const [isEditing, setIsEditing] = useState(false);

  return (
    <div style={expandedShell()}>
      {/* Top action bar */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 24 }}>
        <Button variant="ghost" size="sm" onClick={() => setIsEditing((v) => !v)}>
          {isEditing ? 'Cancel Edit' : 'Edit Trunk'}
        </Button>
        <Button variant="danger" size="sm" onClick={onDelete}>
          Delete Trunk
        </Button>
      </div>

      {isEditing && (
        <div style={{ marginBottom: 28, paddingBottom: 28, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <EditTrunkForm trunk={trunk} onSaved={() => setIsEditing(false)} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 32 }}>
        <IpSection trunkId={trunk.id} />
        <DidSection trunkId={trunk.id} />
        <ConnectionInfo />
      </div>
    </div>
  );
}
