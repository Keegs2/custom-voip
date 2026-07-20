/**
 * TrunkDetail — the expanded body of a trunk card: live activity, authorized
 * IPs, routed DIDs, and the config summary. Each section pulls its own data via
 * the hooks in ../hooks; this file owns only presentation.
 */

import { GLASS } from '../../../components/glass/glass';
import { fmt, fmtMoney } from '../../../utils/format';
import { Button } from '../../../components/ui/Button';
import type { Trunk, TrunkIp } from '../../../types/trunk';
import { AUTH_LABEL } from '../types';
import {
  useTrunkLiveStats,
  useTrunkDids,
  useTrunkIpManager,
} from '../hooks';
import { StatTile } from './StatTile';
import { IconRefresh } from './icons';
import {
  detailWrap,
  sectionLabel,
  sectionLabelHint,
  configCard,
  configRow,
  configLabel,
  configValue,
  infoNote,
  infoBadge,
  ipRow,
  ipMono,
  ipDesc,
  ipInput,
  deleteX,
  didChip,
  refreshBtn,
  spinner,
} from '../styles';
import { useState } from 'react';

// ── Live activity ────────────────────────────────────────────────────────────

function TrunkLiveStats({ trunkId, maxChannels }: { trunkId: number; maxChannels: number }) {
  const statsQuery = useTrunkLiveStats(trunkId);
  const s = statsQuery.data;
  const active = s?.active_channels ?? 0;

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h4 style={sectionLabel}>Live activity</h4>
        <button
          type="button"
          onClick={() => void statsQuery.refetch()}
          disabled={statsQuery.isFetching}
          style={refreshBtn(statsQuery.isFetching)}
        >
          {statsQuery.isFetching ? <span style={spinner(GLASS.accent, 12)} /> : <IconRefresh />}
          Refresh
        </button>
      </div>

      {statsQuery.isError ? (
        <p style={{ fontSize: '0.8rem', color: GLASS.danger, margin: 0 }}>
          Live statistics are temporarily unavailable.
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          <StatTile
            label="Active Channels"
            icon="📡"
            value={
              statsQuery.isLoading ? '…' : (
                <>
                  {active}
                  <span style={{ fontSize: '0.95rem', fontWeight: 500, color: GLASS.textMuted }}> / {maxChannels}</span>
                </>
              )
            }
          />
          <StatTile label="Calls Today" icon="📞" value={statsQuery.isLoading ? '…' : (s?.calls_today ?? 0).toLocaleString()} />
          <StatTile label="Minutes Today" icon="⏱️" value={statsQuery.isLoading ? '…' : Math.round(s?.minutes_today ?? 0).toLocaleString()} />
          <StatTile label="Cost Today" icon="💵" value={statsQuery.isLoading ? '…' : fmtMoney(s?.cost_today ?? 0)} />
        </div>
      )}
    </section>
  );
}

// ── Authorized IPs ───────────────────────────────────────────────────────────

function IpRow({ ip, canManage, onDelete }: { ip: TrunkIp; canManage: boolean; onDelete: (ip: TrunkIp) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div style={ipRow}>
      <span style={ipMono}>{ip.ip_address}</span>
      {ip.description && <span style={ipDesc}>{ip.description}</span>}
      {canManage && (
        <button
          type="button"
          onClick={() => onDelete(ip)}
          title="Remove IP"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={deleteX(hovered)}
        >
          ×
        </button>
      )}
    </div>
  );
}

function TrunkIpManager({ trunkId, canManage }: { trunkId: number; canManage: boolean }) {
  const m = useTrunkIpManager(trunkId);

  return (
    <section>
      <h4 style={sectionLabel}>
        Authorized PBX IPs{' '}
        <span style={sectionLabelHint}>— source addresses permitted to send calls on this trunk</span>
      </h4>

      {m.isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: GLASS.textMuted, fontSize: '0.8rem' }}>
          <span style={spinner(GLASS.accent, 12)} /> Loading IPs…
        </div>
      )}

      {!m.isLoading && m.ips.length === 0 && (
        <p style={{ fontSize: '0.82rem', color: GLASS.warning, margin: '0 0 4px' }}>
          No authorized IPs yet — add your PBX or SBC address below to start sending traffic.
        </p>
      )}

      {m.ips.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {m.ips.map((ip) => (
            <IpRow key={ip.id} ip={ip} canManage={canManage} onDelete={m.handleDelete} />
          ))}
        </div>
      )}

      {canManage && (
        <form onSubmit={m.handleAdd} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <input
              type="text"
              value={m.newIp}
              onChange={(e) => m.setNewIp(e.target.value)}
              onBlur={() => m.setTouched(true)}
              placeholder="203.0.113.50"
              style={ipInput(m.showError)}
            />
            {m.showError && <span style={{ fontSize: '0.66rem', color: GLASS.danger }}>Invalid IPv4 address</span>}
          </div>
          <input
            type="text"
            value={m.newDesc}
            onChange={(e) => m.setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            style={ipInput(false, 190)}
          />
          <Button type="submit" variant="ghost" size="sm" loading={m.addPending}>
            Add IP
          </Button>
        </form>
      )}
    </section>
  );
}

// ── Routed DIDs ──────────────────────────────────────────────────────────────

function TrunkDidList({ trunkId }: { trunkId: number }) {
  const didsQuery = useTrunkDids(trunkId);
  const dids = didsQuery.data ?? [];

  return (
    <section>
      <h4 style={sectionLabel}>Inbound DIDs routed to this trunk</h4>
      {didsQuery.isLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: GLASS.textMuted, fontSize: '0.8rem' }}>
          <span style={spinner(GLASS.accent, 12)} /> Loading DIDs…
        </div>
      ) : dids.length === 0 ? (
        <p style={{ fontSize: '0.82rem', color: GLASS.textMuted, margin: 0 }}>
          No DIDs are currently routed to this trunk.
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {dids.map((d) => (
            <span key={d.id} style={didChip(d.enabled)}>{fmt(d.did)}</span>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Config summary ───────────────────────────────────────────────────────────

function ConfigRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={configRow}>
      <span style={configLabel}>{label}</span>
      <span style={configValue}>{value}</span>
    </div>
  );
}

function TrunkConfigSummary({ trunk }: { trunk: Trunk }) {
  return (
    <section>
      <h4 style={sectionLabel}>Trunk configuration</h4>
      <div style={configCard}>
        <ConfigRow label="Max channels" value={`${trunk.max_channels} concurrent`} />
        <ConfigRow label="CPS limit" value={`${trunk.cps_limit} calls/sec`} />
        <ConfigRow label="Authentication" value={AUTH_LABEL[trunk.auth_type]} />
        {trunk.tech_prefix && <ConfigRow label="Tech prefix" value={trunk.tech_prefix} />}
        <ConfigRow label="Call-path package" value={trunk.package_name ?? 'Default'} />
      </div>
      <p style={infoNote}>
        <span style={infoBadge}>i</span>
        Contact support to change channel capacity, CPS limits, or your call-path package.
      </p>
    </section>
  );
}

// ── Composition ──────────────────────────────────────────────────────────────

export function TrunkDetail({ trunk, canManage }: { trunk: Trunk; canManage: boolean }) {
  return (
    <div style={detailWrap}>
      <TrunkLiveStats trunkId={trunk.id} maxChannels={trunk.max_channels} />
      <TrunkIpManager trunkId={trunk.id} canManage={canManage} />
      <TrunkDidList trunkId={trunk.id} />
      <TrunkConfigSummary trunk={trunk} />
    </div>
  );
}
