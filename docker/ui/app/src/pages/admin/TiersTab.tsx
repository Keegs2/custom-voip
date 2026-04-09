import { useQuery } from '@tanstack/react-query';
import { listTrunkTiers, listApiTiers } from '../../api/tiers';
import { listCallPaths } from '../../api/trunks';
import { Spinner } from '../../components/ui/Spinner';
import { Badge } from '../../components/ui/Badge';
import { TableWrap, Table, Thead, Th, Td } from '../../components/ui/Table';
import { TierCard } from './TierCard';

interface SectionCardProps {
  title: string;
  description: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}

function SectionCard({ title, description, badge, children }: SectionCardProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '24px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 24,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 700,
              color: '#e2e8f0',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            {title}
          </h2>
          <p style={{ fontSize: '0.875rem', color: '#718096', marginTop: 4, lineHeight: 1.5 }}>
            {description}
          </p>
        </div>
        {badge && <div style={{ flexShrink: 0 }}>{badge}</div>}
      </div>
      {children}
    </div>
  );
}

export function TiersTab() {
  const { data: trunkTiers, isLoading: trunkLoading, isError: trunkError } = useQuery({
    queryKey: ['tiers', 'trunk'],
    queryFn: listTrunkTiers,
  });

  const { data: apiTiers, isLoading: apiLoading, isError: apiError } = useQuery({
    queryKey: ['tiers', 'api'],
    queryFn: listApiTiers,
  });

  const { data: callPaths, isLoading: callPathsLoading, isError: callPathsError } = useQuery({
    queryKey: ['trunks', 'call-paths'],
    queryFn: listCallPaths,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Trunk Tiers */}
      <SectionCard
        title="SIP Trunk Tiers"
        description="Standard SIP trunk access. CPS and call paths are configured independently."
        badge={<Badge variant="warn">5 CPS Standard</Badge>}
      >
        {trunkLoading && (
          <div className="flex items-center gap-2.5 text-[#718096] py-6">
            <Spinner /> Loading tiers…
          </div>
        )}
        {trunkError && (
          <p className="text-red-400 text-sm py-4">Failed to load trunk tiers.</p>
        )}
        {!trunkLoading && !trunkError && (
          <>
            {(trunkTiers?.length ?? 0) === 0 ? (
              <p className="text-[#718096] text-sm py-4">No trunk tiers configured.</p>
            ) : trunkTiers!.length === 1 ? (
              <div className="grid grid-cols-1">
                <TierCard tier={trunkTiers![0]} tierType="trunk" fullWidth />
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {trunkTiers!.map((t) => (
                  <TierCard key={t.id} tier={t} tierType="trunk" />
                ))}
              </div>
            )}
          </>
        )}
      </SectionCard>

      {/* API Calling Tiers */}
      <SectionCard
        title="API Calling Tiers"
        description="Higher CPS limits with per-call billing for programmatic call control."
        badge={<Badge variant="active">Up to 15 CPS</Badge>}
      >
        {apiLoading && (
          <div className="flex items-center gap-2.5 text-[#718096] py-6">
            <Spinner /> Loading tiers…
          </div>
        )}
        {apiError && (
          <p className="text-red-400 text-sm py-4">Failed to load API tiers.</p>
        )}
        {!apiLoading && !apiError && (
          <>
            {(apiTiers?.length ?? 0) === 0 ? (
              <p className="text-[#718096] text-sm py-4">No API tiers configured.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {apiTiers!.map((t) => (
                  <TierCard key={t.id} tier={t} tierType="api" />
                ))}
              </div>
            )}
          </>
        )}
      </SectionCard>

      {/* Call Path Packages */}
      <SectionCard
        title="Call Path Packages"
        description="Call paths are purchased per-trunk and control concurrent call capacity. CPS and call paths are independent."
      >
        {callPathsLoading && (
          <div className="flex items-center gap-2.5 text-[#718096] py-6">
            <Spinner /> Loading packages…
          </div>
        )}
        {callPathsError && (
          <p className="text-red-400 text-sm py-4">Failed to load call path packages.</p>
        )}
        {!callPathsLoading && !callPathsError && (
          <>
            {(callPaths?.length ?? 0) === 0 ? (
              <p className="text-[#718096] text-sm py-4">No call path packages configured.</p>
            ) : (
              <TableWrap>
                <Table>
                  <Thead>
                    <tr>
                      <Th>Package</Th>
                      <Th>Call Paths</Th>
                      <Th>Monthly Fee</Th>
                    </tr>
                  </Thead>
                  <tbody>
                    {callPaths!.map((p) => (
                      <tr key={p.id} className="hover:bg-white/[0.02] transition-colors">
                        <Td>
                          <span className="font-semibold text-[#e2e8f0]">
                            {p.name || '--'}
                          </span>
                          {p.description && (
                            <span className="text-[#718096] text-xs ml-2">
                              {p.description}
                            </span>
                          )}
                        </Td>
                        <Td className="tabular-nums">{p.call_paths ?? p.paths ?? '--'}</Td>
                        <Td className="tabular-nums">
                          {p.monthly_fee != null
                            ? `$${Number(p.monthly_fee).toFixed(2)}/mo`
                            : '--'}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </>
        )}
      </SectionCard>
    </div>
  );
}
