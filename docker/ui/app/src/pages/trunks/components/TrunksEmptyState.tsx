/**
 * TrunksEmptyState — the educational "no trunks yet" panel: a glass surface with
 * the product pitch, a 4-step "how it works" grid, and the primary CTA.
 */

import { Link } from 'react-router-dom';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { Button } from '../../../components/ui/Button';
import { IconTrunk } from '../../../components/icons/ProductIcons';
import { stateIcon, howItWorksStep } from '../styles';

function HowItWorksStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 14, textAlign: 'left' }}>
      <div style={howItWorksStep()}>{n}</div>
      <div>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: GLASS.text, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: '0.8rem', color: GLASS.textMuted, lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

interface TrunksEmptyStateProps {
  isAdmin: boolean;
  canCreate: boolean;
  onCreate: () => void;
}

export function TrunksEmptyState({ isAdmin, canCreate, onCreate }: TrunksEmptyStateProps) {
  return (
    <GlassPanel padding="48px 32px">
      <div style={{ textAlign: 'center' }}>
        <div style={{ ...stateIcon(), marginBottom: 18 }}>
          <IconTrunk size={30} />
        </div>

        <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: GLASS.text, marginBottom: 8 }}>
          Enterprise SIP trunking
        </h2>
        <p style={{ fontSize: '0.9rem', color: GLASS.textMuted, maxWidth: 560, margin: '0 auto 8px', lineHeight: 1.6 }}>
          Connect your PBX or SBC directly to our carrier-grade network. Each trunk is
          IP-authenticated, capped to a concurrent-channel limit, and protected by per-second
          call-rate (CPS) enforcement — with real-time channel, volume and cost monitoring.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 22,
            maxWidth: 720,
            margin: '32px auto',
            textAlign: 'left',
          }}
        >
          <HowItWorksStep n={1} title="Authorize your IPs" body="Add your PBX/SBC source addresses to the trunk's allow-list. Only those IPs may send calls." />
          <HowItWorksStep n={2} title="Point your DIDs" body="Inbound numbers assigned to the trunk are delivered straight to your equipment." />
          <HowItWorksStep n={3} title="Send & receive" body="Place calls within your channel and CPS limits — overflow is rejected to protect quality." />
          <HowItWorksStep n={4} title="Monitor live" body="Track active channels, daily volume and spend in real time from each trunk's dashboard." />
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          {isAdmin && canCreate && (
            <Button variant="primary" onClick={onCreate}>Create your first trunk</Button>
          )}
          <Link to="/docs/api" style={{ textDecoration: 'none' }}>
            <Button variant="ghost">Read the API reference</Button>
          </Link>
        </div>

        {isAdmin && !canCreate && (
          <p style={{ fontSize: '0.78rem', color: GLASS.textMuted, marginTop: 16 }}>
            Select a specific customer above to create a trunk for them.
          </p>
        )}
        {!isAdmin && (
          <p style={{ fontSize: '0.78rem', color: GLASS.textMuted, marginTop: 16 }}>
            Need a trunk provisioned? Contact your account team to get started.
          </p>
        )}
      </div>
    </GlassPanel>
  );
}
