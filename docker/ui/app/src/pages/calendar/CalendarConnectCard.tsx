/**
 * Connections bar — one chip per provider. Shows connected account email with a
 * Disconnect action, a Reconnect affordance when a connection needs re-auth
 * (either the stored status OR a live `providers[].error === 'needs_reauth'`
 * from the events response, per plan §2.6 / §4), and a Connect button for
 * providers that aren't linked yet.
 */
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import type {
  CalendarProvider,
  Connection,
  ProviderResult,
} from '../../types/calendar';
import { ALL_PROVIDERS, PROVIDER_META } from './providerMeta';

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
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        padding: '14px 18px',
        marginBottom: 18,
        background: 'rgba(19, 21, 29, 0.72)',
        border: '1px solid rgba(45, 212, 191, 0.16)',
        borderRadius: 14,
      }}
    >
      <span
        style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: '#475569',
          marginRight: 4,
        }}
      >
        Connected calendars
      </span>

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
        const dotColor = needsReauth ? '#f59e0b' : '#22c55e';
        return (
          <div
            key={provider}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 9,
              padding: '5px 6px 5px 12px',
              borderRadius: 10,
              background: 'rgba(15, 17, 23, 0.6)',
              border: `1px solid ${needsReauth ? 'rgba(245,158,11,0.3)' : 'rgba(42,47,69,0.7)'}`,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: dotColor,
                flexShrink: 0,
                boxShadow: `0 0 6px ${dotColor}`,
              }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: meta.color }}>
                {meta.short}
              </span>
              <span
                style={{
                  fontSize: '0.68rem',
                  color: '#94a3b8',
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
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderRadius: 7,
                border: '1px solid rgba(42,47,69,0.6)',
                background: 'transparent',
                color: '#64748b',
                cursor: isDisconnecting ? 'wait' : 'pointer',
                flexShrink: 0,
                padding: 0,
                transition: 'color 0.15s, background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                if (isDisconnecting) return;
                e.currentTarget.style.color = '#f87171';
                e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
                e.currentTarget.style.borderColor = 'rgba(239,68,68,0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#64748b';
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.borderColor = 'rgba(42,47,69,0.6)';
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
  );
}
