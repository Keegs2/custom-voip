/**
 * WebhookSecretPanel — the account-level HMAC signing-secret surface, in a
 * frosted glass panel. All state + the live reveal/rotate/copy actions come from
 * `useWebhookSecret`. Admin-scoped 403s surface as friendly messages.
 *
 * React #310: the single hook sits at the top, before any return.
 */

import { Link } from 'react-router-dom';
import { KeyRound, Eye, EyeOff, RotateCw, Copy, Check, BookOpen } from 'lucide-react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { Button } from '../../../components/ui/Button';
import { useWebhookSecret } from '../hooks';
import {
  secretTitleRow,
  secretTitle,
  secretBlurb,
  secretCode,
  secretBox,
  secretValue,
  iconBtn,
  noticeBox,
  errBox,
  docLink,
} from '../styles';

export function WebhookSecretPanel({ customerId }: { customerId: number | undefined }) {
  const s = useWebhookSecret(customerId);

  return (
    <GlassPanel padding="22px 24px" style={{ marginBottom: 22 }}>
      <div style={secretTitleRow}>
        <KeyRound size={16} style={{ color: GLASS.warning, flexShrink: 0 }} />
        <span style={secretTitle}>Webhook Signing Secret</span>
      </div>
      <p style={secretBlurb}>
        Every programmable-voice callback is signed with an HMAC over the request body, sent in the{' '}
        <code style={secretCode}>{s.headerName}</code> header. Verify it on your endpoint to prove the request came from us.
      </p>

      {customerId === undefined ? (
        <div style={noticeBox}>
          The signing secret is managed per customer. Open a specific customer above to view or rotate their secret.
        </div>
      ) : (
        <>
          <div style={secretBox}>
            <code style={secretValue}>
              {s.secret && s.revealed
                ? s.secret.webhook_signing_secret
                : s.secret
                  ? '•'.repeat(Math.min(40, s.secret.webhook_signing_secret.length))
                  : '— not loaded —'}
            </code>
            {s.secret && (
              <>
                <button type="button" onClick={s.toggleReveal} title={s.revealed ? 'Hide' : 'Reveal'} style={iconBtn()}>
                  {s.revealed ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button type="button" onClick={s.copy} title="Copy" style={iconBtn(s.copied)}>
                  {s.copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </>
            )}
          </div>

          {s.errMsg && <div style={errBox}>{s.errMsg}</div>}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {!s.secret && (
              <Button size="sm" variant="ghost" icon={<Eye size={14} />} loading={s.loading} onClick={s.reveal}>
                Reveal secret
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<RotateCw size={14} />} loading={s.rotating} onClick={s.rotate}>
              Rotate secret
            </Button>
            <Link to="/docs/api" style={docLink()}>
              <BookOpen size={13} />
              Signature verification recipe
            </Link>
          </div>
        </>
      )}
    </GlassPanel>
  );
}
