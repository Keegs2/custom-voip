/**
 * Connections bar — one chip per provider, inside a frosted glass panel. Shows
 * the connected account email with a Disconnect action, a Reconnect affordance
 * when a connection needs re-auth (stored status OR a live
 * `providers[].error === 'needs_reauth'` from the events response, per plan
 * §2.6 / §4), and a Connect button for providers that aren't linked yet.
 */
import { Button } from '../../../components/ui/Button';
import { Spinner } from '../../../components/ui/Spinner';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import type {
  CalendarProvider,
  Connection,
  ProviderResult,
} from '../../../types/calendar';
import { ALL_PROVIDERS, PROVIDER_META } from '../providerMeta';
import { connectionChip, connectLabel, disconnectBtn, statusDot } from '../styles';

interface CalendarConnectCardProps {
  connections: Connection[];
  /** Per-provider live results from the events response (optional). */
  providerResults: ProviderResult[];
  onConnect: (provider: CalendarProvider) => void;
  onDisconnect: (provider: CalendarProvider) => void;
  /** Provider whose connect URL is being fetched (button spinner). */
  connecting: CalendarProvider | null;
  /** Provider currently being disconnected (button spinner). */
  disconnecting: CalendarProvider | null;
}

interface ProviderState {
  provider: CalendarProvider;
  connection: Connection | null;
  /** True when the stored status or a live provider error needs re-auth. */
  needsReauth: boolean;
}

function buildState(
  connections: Connection[],
  providerResults: ProviderResult[],
): ProviderState[] {
  return ALL_PROVIDERS.map((provider) => {
    const connection = connections.find((c) => c.provider === provider) ?? null;
    const liveError = providerResults.find((p) => p.provider === provider);
    const needsReauth =
      connection?.status === 'needs_reauth' ||
      connection?.status === 'revoked' ||
      liveError?.error === 'needs_reauth';
    return { provider, connection, needsReauth };
  });
}

export function CalendarConnectCard({
  connections,
  providerResults,
  onConnect,
  onDisconnect,
  connecting,
  disconnecting,
}: CalendarConnectCardProps) {
  const states = buildState(connections, providerResults);

  return (
    <GlassPanel padding="14px 18px">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <span style={connectLabel}>Connected calendars</span>

        {states.map(({ provider, connection, needsReauth }) => {
          const meta = PROVIDER_META[provider];
          const isConnecting = connecting === provider;
          const isDisconnecting = disconnecting === provider;

          // Not linked → a single Connect button.
          if (!connection) {
            return (
              <Button
                key={provider}
                variant="ghost"
                size="sm"
                loading={isConnecting}
                onClick={() => onConnect(provider)}
                icon={
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: meta.color,
                      display: 'inline-block',
                    }}
                  />
                }
              >
                Connect {meta.short}
              </Button>
            );
          }

          // Linked → chip with status + Reconnect / Disconnect actions.
          const dotColor = needsReauth ? GLASS.warning : GLASS.success;
          return (
            <div key={provider} style={connectionChip(needsReauth)}>
              <span style={statusDot(dotColor)} />
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: meta.color }}>
                  {meta.short}
                </span>
                <span
                  style={{
                    fontSize: '0.68rem',
                    color: GLASS.textMuted,
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={connection.account_email}
                >
                  {needsReauth ? 'Reconnect required' : connection.account_email}
                </span>
              </span>

              {needsReauth && (
                <Button
                  variant="primary"
                  size="xs"
                  loading={isConnecting}
                  onClick={() => onConnect(provider)}
                >
                  Reconnect
                </Button>
              )}

              <button
                type="button"
                onClick={() => onDisconnect(provider)}
                disabled={isDisconnecting}
                aria-label={`Disconnect ${meta.label}`}
                title={`Disconnect ${meta.label}`}
                style={{ ...disconnectBtn(), cursor: isDisconnecting ? 'wait' : 'pointer' }}
                onMouseEnter={(e) => {
                  if (isDisconnecting) return;
                  e.currentTarget.style.color = GLASS.danger;
                  e.currentTarget.style.background = hexToRgba(GLASS.danger, 0.1);
                  e.currentTarget.style.borderColor = hexToRgba(GLASS.danger, 0.3);
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = GLASS.textMuted;
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
                }}
              >
                {isDisconnecting ? (
                  <Spinner size="xs" />
                ) : (
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    style={{ width: 11, height: 11 }}
                  >
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}
