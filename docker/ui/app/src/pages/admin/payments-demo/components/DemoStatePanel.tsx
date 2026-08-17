/**
 * DemoStatePanel — the live "world state" pane beside the scenario triggers:
 * seeded/unseeded posture, the demo customer, the prepaid balance, the
 * auto-recharge + dunning state, the card on file, open agent tabs, and the
 * recent scenario trail. Polls via the shared demo-state query so every
 * scenario visibly lands here the moment it posts.
 */

import type { DemoState } from '../types';
import { fmtDollars, fmtWhen } from '../format';

function Tile({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="dl-tile">
      <span className="dl-tile-label">{label}</span>
      <span className="dl-tile-value" style={{ fontSize: '0.98rem' }}>{value}</span>
      {hint && <span className="dl-tile-hint">{hint}</span>}
    </div>
  );
}

export function DemoStatePanel({ state }: { state?: DemoState }) {
  const seeded = state?.seeded ?? false;
  const ar = state?.auto_recharge ?? null;
  const methods = state?.payment_methods ?? [];
  const defaultCard = methods.find((m) => m.is_default) ?? methods[0] ?? null;
  const openTabs = (state?.mpp_sessions ?? []).filter((s) => s.status === 'open').length;
  const activity = state?.activity ?? [];
  const inDunning = Boolean(ar && (ar.disabled_reason || ar.consecutive_failures > 0));

  return (
    <section className="dl-panel">
      <div className="dl-panel-head">
        <span className="dl-panel-title">Live demo state</span>
        <span className={seeded ? 'dl-pill dl-pill-on' : 'dl-tag dl-tag-slate'}>
          {seeded ? 'Seeded' : 'Not seeded'}
        </span>
        {state?.customer && <span className="dl-tag">{state.customer.name}</span>}
      </div>

      <div className="dl-panel-body">
        {!seeded ? (
          <div className="dl-empty">
            No demo customer yet. Run <strong>Seed</strong> to provision
            &ldquo;DEMO — Acme Robotics&rdquo; with a $250 starting balance, a card on
            file, and auto-recharge armed at the $50 threshold.
          </div>
        ) : (
          <>
            <div className="dlx9-balance-row">
              <div>
                <span className="dl-tile-label" style={{ display: 'block', marginBottom: 8 }}>
                  Prepaid balance · USD
                </span>
                <span className="dlx9-balance">{fmtDollars(state?.balance ?? 0)}</span>
              </div>
              <span
                className={
                  ar?.enabled
                    ? inDunning
                      ? 'dl-pill dl-pill-off'
                      : 'dl-pill dl-pill-on'
                    : 'dl-tag dl-tag-slate'
                }
              >
                {ar?.enabled
                  ? inDunning
                    ? 'Auto-recharge in dunning'
                    : 'Auto-recharge armed'
                  : 'Auto-recharge off'}
              </span>
            </div>

            {/* Dunning banner — the decline scenario's visible outcome */}
            {inDunning && ar && (
              <div className="dl-banner dl-banner-warn" style={{ marginTop: 14 }}>
                <strong>Dunning:</strong>{' '}
                {ar.consecutive_failures} consecutive card failure
                {ar.consecutive_failures === 1 ? '' : 's'}
                {ar.disabled_reason ? ` — ${ar.disabled_reason}` : ''}.{' '}
                {ar.enabled
                  ? 'Auto-recharge stays armed until the failure cap disables it.'
                  : 'Auto-recharge is disabled until a human fixes the card.'}
              </div>
            )}

            <div className="dlx9-statgrid">
              <Tile
                label="Auto-recharge"
                value={
                  ar?.threshold != null && ar?.recharge_amount != null
                    ? `< ${fmtDollars(ar.threshold)} → +${fmtDollars(ar.recharge_amount)}`
                    : '—'
                }
                hint={ar?.daily_cap != null ? `Daily cap ${fmtDollars(ar.daily_cap)} (closed-loop)` : undefined}
              />
              <Tile
                label="Card on file"
                value={
                  defaultCard
                    ? `${(defaultCard.brand ?? 'card').toUpperCase()} •••• ${defaultCard.last4 ?? '????'}`
                    : 'None'
                }
                hint={
                  defaultCard
                    ? `Token ${defaultCard.provider_pm_id.slice(0, 14)}… — no PAN stored`
                    : 'Seed mints a demo Visa'
                }
              />
              <Tile label="Open agent tabs" value={String(openTabs)} hint="Spend-limited MPP sessions" />
              <Tile
                label="Last scenario"
                value={activity.length > 0 ? activity[0].scenario.replace('_', ' ') : 'none yet'}
                hint={activity.length > 0 ? fmtWhen(activity[0].created_at) : undefined}
              />
            </div>

            {/* Recent scenario trail */}
            {activity.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="dl-section-title">Scenario log</div>
                <div>
                  {activity.slice(0, 5).map((a, i) => (
                    <div key={`${a.created_at}-${i}`} className="dlx9-act">
                      <span className="dlx9-act-name">{a.scenario.replace('_', ' ')}</span>
                      <span className="dlx9-act-when">{fmtWhen(a.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
