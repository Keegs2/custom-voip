import { useQuery } from '@tanstack/react-query';
import { listTrunkTiers, listApiTiers } from '../../api/tiers';
import { listCallPaths } from '../../api/trunks';
import { Spinner } from '../../components/ui/Spinner';
import { TableWrap, Table, Thead, Th, Td } from '../../components/ui/Table';
import { TierCard } from './TierCard';

export function TiersTab() {
  const {
    data: trunkTiers,
    isLoading: trunkLoading,
    isError: trunkError,
  } = useQuery({
    queryKey: ['tiers', 'trunk'],
    queryFn: listTrunkTiers,
  });

  const {
    data: apiTiers,
    isLoading: apiLoading,
    isError: apiError,
  } = useQuery({
    queryKey: ['tiers', 'api'],
    queryFn: listApiTiers,
  });

  const {
    data: callPaths,
    isLoading: callPathsLoading,
    isError: callPathsError,
  } = useQuery({
    queryKey: ['trunks', 'call-paths'],
    queryFn: listCallPaths,
  });

  const isLoading = trunkLoading || apiLoading;

  return (
    <div className="space-y-6">
      {/* Trunk Tiers section */}
      <div className="bg-[#1a1d27] border border-[#2a2f45] rounded-[10px] p-[20px_22px]">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[1rem] font-bold text-[#e2e8f0]">SIP Trunk Tiers</h2>
            <p className="text-[0.78rem] text-[#718096] mt-0.5">
              Standard SIP trunk access. CPS and call paths are configured independently.
            </p>
          </div>
          <span className="inline-flex items-center text-[0.68rem] font-bold px-[9px] py-[2px] rounded-full tracking-[0.5px] uppercase bg-amber-500/[0.10] text-amber-300 border border-amber-500/30">
            5 CPS Standard
          </span>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-[#718096] py-6">
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
              /* Single trunk tier: full-width card */
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
      </div>

      {/* API Calling Tiers section */}
      <div className="bg-[#1a1d27] border border-[#2a2f45] rounded-[10px] p-[20px_22px]">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[1rem] font-bold text-[#e2e8f0]">API Calling Tiers</h2>
            <p className="text-[0.78rem] text-[#718096] mt-0.5">
              Higher CPS limits with per-call billing for programmatic call control.
            </p>
          </div>
          <span className="inline-flex items-center text-[0.68rem] font-bold px-[9px] py-[2px] rounded-full tracking-[0.5px] uppercase bg-green-500/[0.12] text-green-400 border border-green-500/25">
            Up to 15 CPS
          </span>
        </div>

        {apiLoading && (
          <div className="flex items-center gap-2 text-[#718096] py-6">
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
      </div>

      {/* Call Path Packages section */}
      <div className="bg-[#1a1d27] border border-[#2a2f45] rounded-[10px] p-[20px_22px]">
        <div className="mb-4">
          <h2 className="text-[1rem] font-bold text-[#e2e8f0]">Call Path Packages</h2>
          <p className="text-[0.78rem] text-[#718096] mt-0.5">
            Call paths are purchased per-trunk and control concurrent call capacity.
            CPS and call paths are independent.
          </p>
        </div>

        {callPathsLoading && (
          <div className="flex items-center gap-2 text-[#718096] py-6">
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
                            <span className="text-[#718096] text-[0.78rem] ml-2">
                              {p.description}
                            </span>
                          )}
                        </Td>
                        <Td className="tabular-nums">
                          {p.call_paths ?? p.paths ?? '--'}
                        </Td>
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
      </div>
    </div>
  );
}
