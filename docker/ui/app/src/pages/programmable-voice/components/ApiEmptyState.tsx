/**
 * ApiEmptyState — the educational empty state shown when a customer has no
 * programmable numbers yet. Frosted glass panel with the webhook contract, a
 * 3-step "how it works" grid, and the primary CTA.
 */

import { Link } from 'react-router-dom';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { IconAPI } from '../../../components/icons/ProductIcons';
import { Button } from '../../../components/ui/Button';
import { emptyIcon, stepNum, contractBox } from '../styles';

function HowItWorksStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 14, textAlign: 'left' }}>
      <div style={stepNum()}>{n}</div>
      <div>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: GLASS.text, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: '0.8rem', color: GLASS.textMuted, lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

interface ApiEmptyStateProps {
  isAdmin: boolean;
  canCreate: boolean;
  onCreate: () => void;
}

export function ApiEmptyState({ isAdmin, canCreate, onCreate }: ApiEmptyStateProps) {
  return (
    <GlassPanel padding="48px 32px">
      <div style={{ textAlign: 'center' }}>
        <div style={emptyIcon()}>
          <IconAPI size={30} />
        </div>

        <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: GLASS.text, marginBottom: 8 }}>
          Programmable voice
        </h2>
        <p style={{ fontSize: '0.9rem', color: GLASS.textMuted, maxWidth: 580, margin: '0 auto', lineHeight: 1.6 }}>
          Control calls in real time with simple webhooks. When a call hits one of your numbers,
          we POST the call details to your <strong style={{ color: GLASS.text }}>Voice URL</strong> — you respond
          with TwiML telling us what to do next. An optional{' '}
          <strong style={{ color: GLASS.text }}>Status Callback</strong> streams lifecycle events as the call progresses.
        </p>

        {/* Webhook contract */}
        <div style={contractBox()}>
          <div style={{ color: GLASS.accent }}># Inbound call → your Voice URL</div>
          <div><span style={{ color: GLASS.success }}>POST</span> https://your-app.com/voice</div>
          <div>From=+16175551234&amp;To=+16175550000&amp;CallSid=CA…</div>
          <div style={{ marginTop: 10, color: GLASS.accent }}># Your response (TwiML)</div>
          <div style={{ color: GLASS.text }}>&lt;Response&gt;&lt;Say&gt;Hello&lt;/Say&gt;&lt;Dial&gt;+16175559999&lt;/Dial&gt;&lt;/Response&gt;</div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 22,
            maxWidth: 720,
            margin: '8px auto 28px',
            textAlign: 'left',
          }}
        >
          <HowItWorksStep n={1} title="Point your Voice URL" body="Set the webhook each number calls when a call comes in." />
          <HowItWorksStep n={2} title="Return TwiML" body="Say, play, gather digits, record, or dial — driven entirely by your app." />
          <HowItWorksStep n={3} title="Track status" body="Add a status callback to log answered/completed events in real time." />
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {isAdmin && canCreate && (
            <Button variant="primary" onClick={onCreate}>Add your first number</Button>
          )}
          <Link to="/docs/api" style={{ textDecoration: 'none' }}>
            <Button variant="ghost">API reference</Button>
          </Link>
        </div>

        <p style={{ fontSize: '0.78rem', color: GLASS.textMuted, marginTop: 18 }}>
          Prefer no-code? Build call logic visually with the Call Flow Builder and publish it to any number.
        </p>
        {isAdmin && !canCreate && (
          <p style={{ fontSize: '0.78rem', color: GLASS.textMuted, marginTop: 6 }}>
            Select a specific customer above to add a number for them.
          </p>
        )}
      </div>
    </GlassPanel>
  );
}
