import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  listTrunks,
  createTrunk,
  updateTrunk,
  getTrunkIps,
  addTrunkIp,
  deleteTrunkIp,
  getTrunkDids,
  listCallPathPackages,
} from '../../api/trunks';
import { apiRequest } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import type { Trunk, TrunkIp, TrunkDid, TrunkAuthType } from '../../types/trunk';

// ----- Types -----

interface TrunkWithDetails extends Trunk {
  ips: TrunkIp[];
  dids: TrunkDid[];
}

// ----- TrunkCard -----

interface TrunkCardProps {
  trunk: TrunkWithDetails;
  customerId: number;
}

const SIP_SERVER = '34.74.71.32:5080';

function TrunkCard({ trunk, customerId }: TrunkCardProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [newIp, setNewIp] = useState('');
  const [newIpDesc, setNewIpDesc] = useState('');
  const [newDid, setNewDid] = useState('');
  const [selectedPackageId, setSelectedPackageId] = useState('');

  const invalidateTrunks = () =>
    qc.invalidateQueries({ queryKey: ['customerTrunks', customerId] });

  // Call path packages
  const { data: packages } = useQuery({
    queryKey: ['callPathPackages'],
    queryFn: listCallPathPackages,
  });

  // Toggle trunk enabled
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => updateTrunk(trunk.id, { enabled }),
    onSuccess: (_data, enabled) => {
      invalidateTrunks();
      toastOk(enabled ? 'Trunk enabled' : 'Trunk disabled');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Add IP
  const addIpMutation = useMutation({
    mutationFn: () =>
      addTrunkIp(trunk.id, newIp.trim(), newIpDesc.trim() || undefined),
    onSuccess: () => {
      invalidateTrunks();
      setNewIp('');
      setNewIpDesc('');
      toastOk(`IP ${newIp.trim()} added`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Remove IP
  const removeIpMutation = useMutation({
    mutationFn: (ipId: number) => deleteTrunkIp(trunk.id, ipId),
    onSuccess: () => {
      invalidateTrunks();
      toastOk('IP removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Add DID
  const addDidMutation = useMutation({
    mutationFn: () =>
      apiRequest<TrunkDid>('POST', `/trunks/${trunk.id}/dids`, { did: newDid.trim() }),
    onSuccess: () => {
      invalidateTrunks();
      setNewDid('');
      toastOk(`DID ${newDid.trim()} assigned`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Assign call path package
  const assignPackageMutation = useMutation({
    mutationFn: (packageId: number) =>
      apiRequest('PUT', `/trunks/${trunk.id}/call-paths`, { package_id: packageId }),
    onSuccess: () => {
      invalidateTrunks();
      setSelectedPackageId('');
      toastOk('Call path package assigned');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleAddIp(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newIp.trim()) { toastErr('IP address is required'); return; }
    addIpMutation.mutate();
  }

  function handleAddDid(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newDid.trim()) { toastErr('DID is required'); return; }
    addDidMutation.mutate();
  }

  function handleApplyPackage(e: React.MouseEvent) {
    e.stopPropagation();
    if (!selectedPackageId) { toastErr('Select a call path package'); return; }
    assignPackageMutation.mutate(parseInt(selectedPackageId, 10));
  }

  function handleRemoveIp(ip: TrunkIp) {
    if (!confirm('Remove this IP?')) return;
    removeIpMutation.mutate(ip.id);
  }

  const showAuthIps = trunk.auth_type === 'ip' || trunk.auth_type === 'both';

  return (
    <div className="bg-[#1e2130] border border-[#2a2f45] rounded-lg p-3 mb-3">
      {/* Trunk header */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="flex-1 text-[0.9rem] font-bold text-[#e2e8f0]">
          {trunk.trunk_name}
        </div>
        <Badge variant={trunk.enabled ? 'active' : 'disabled'}>
          {trunk.enabled ? 'Active' : 'Disabled'}
        </Badge>
        <span className="text-[0.75rem] text-[#718096]">{trunk.auth_type} auth</span>
        <span className="text-[0.75rem] text-[#718096]">ID: {trunk.id}</span>
      </div>

      {/* Quick stats */}
      <div className="flex gap-4 flex-wrap text-[0.78rem] text-[#718096] mb-3 pb-3 border-b border-[#2a2f45]">
        <span>
          Channels: <strong className="text-[#e2e8f0]">{trunk.max_channels}</strong>
        </span>
        <span>
          CPS: <strong className="text-[#e2e8f0]">{trunk.cps_limit ?? '--'}</strong>
        </span>
        <span>
          IPs: <strong className="text-[#e2e8f0]">{trunk.ips.length}</strong>
        </span>
        <span>
          DIDs: <strong className="text-[#e2e8f0]">{trunk.dids.length}</strong>
        </span>
      </div>

      {/* Customer Connection Details */}
      <div className="text-[0.63rem] font-bold text-[#3b82f6] uppercase tracking-[0.7px] mb-2">
        Customer Connection Details
      </div>
      <div className="bg-[#0d0f15] border border-[#2a2f45] rounded-md p-3 mb-3 font-mono text-[0.82rem]">
        <div className="flex gap-2 mb-1.5">
          <span className="text-[#718096] min-w-[110px]">SIP Server:</span>
          <span className="text-[#e2e8f0]">{SIP_SERVER}</span>
        </div>
        <div className="flex gap-2 mb-1.5">
          <span className="text-[#718096] min-w-[110px]">Auth Type:</span>
          <span className="text-[#e2e8f0]">{trunk.auth_type.toUpperCase()}</span>
        </div>
        {showAuthIps && (
          <div className="flex gap-2 mb-1.5">
            <span className="text-[#718096] min-w-[110px]">Auth IPs:</span>
            <span className="text-[#e2e8f0]">
              {trunk.ips.length > 0 ? (
                trunk.ips
                  .map((ip) => ip.ip_address + (ip.description ? ` (${ip.description})` : ''))
                  .join(', ')
              ) : (
                <span className="text-[#fca5a5]">None configured</span>
              )}
            </span>
          </div>
        )}
        {trunk.tech_prefix && (
          <div className="flex gap-2 mb-1.5">
            <span className="text-[#718096] min-w-[110px]">Tech Prefix:</span>
            <span className="text-[#e2e8f0]">{trunk.tech_prefix}</span>
          </div>
        )}
        <div className="flex gap-2 mb-1.5">
          <span className="text-[#718096] min-w-[110px]">Max Channels:</span>
          <span className="text-[#e2e8f0]">{trunk.max_channels}</span>
        </div>
        <div className="flex gap-2 mb-1.5">
          <span className="text-[#718096] min-w-[110px]">CPS Limit:</span>
          <span className="text-[#e2e8f0]">{trunk.cps_limit}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-[#718096] min-w-[110px]">DIDs:</span>
          <span className="text-[#e2e8f0]">
            {trunk.dids.length > 0
              ? trunk.dids.map((d) => d.did).join(', ')
              : 'None assigned'}
          </span>
        </div>
      </div>

      {/* Capacity section */}
      <div className="text-[0.63rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-2">
        Capacity
      </div>
      <div className="flex gap-5 flex-wrap items-baseline text-[0.82rem] mb-2">
        <div>
          <span className="text-[#718096]">Call Paths: </span>
          <strong className="text-[#e2e8f0]">{trunk.max_channels}</strong>
          {trunk.package_name && (
            <span className="text-[#718096] text-[0.75rem] ml-1">({trunk.package_name})</span>
          )}
        </div>
        <div>
          <span className="text-[#718096]">CPS Limit: </span>
          <strong className="text-[#e2e8f0]">{trunk.cps_limit}</strong>
          <span className="text-[#718096] text-[0.75rem] ml-1">(standard trunk tier)</span>
        </div>
      </div>
      <div className="text-[0.75rem] text-[#718096] mb-1.5">Change call path package:</div>
      <div
        className="flex gap-2 items-center flex-wrap mb-3"
        onClick={(e) => e.stopPropagation()}
      >
        <select
          value={selectedPackageId}
          onChange={(e) => setSelectedPackageId(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className="text-[0.82rem] px-2 py-[5px] rounded-lg max-w-[280px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] cursor-pointer"
        >
          <option value="">
            Current: {trunk.max_channels} paths
            {trunk.package_name ? ` (${trunk.package_name})` : ''} — no change
          </option>
          {(packages ?? []).map((pkg) => (
            <option key={pkg.id} value={String(pkg.id)}>
              {pkg.name} — {pkg.max_channels ?? '∞'} paths, ${pkg.monthly_fee.toFixed(2)}/mo
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          size="xs"
          loading={assignPackageMutation.isPending}
          onClick={handleApplyPackage}
        >
          Apply
        </Button>
      </div>

      {/* Authorized IPs */}
      <div className="text-[0.63rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-2">
        Authorized IPs
      </div>
      {trunk.ips.length === 0 ? (
        <div className="text-[0.78rem] text-[#718096] py-1">No IPs configured</div>
      ) : (
        <div className="flex flex-col gap-1 mb-1">
          {trunk.ips.map((ip) => (
            <div
              key={ip.id}
              className="flex items-center gap-3 text-[0.78rem]"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="font-mono text-[#e2e8f0]">{ip.ip_address}</span>
              {ip.description && (
                <span className="text-[#718096]">{ip.description}</span>
              )}
              <Button
                variant="danger"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemoveIp(ip);
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={handleAddIp}
        onClick={(e) => e.stopPropagation()}
        className="flex gap-2 mt-2 items-center flex-wrap"
      >
        <input
          type="text"
          value={newIp}
          onChange={(e) => setNewIp(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="192.0.2.1"
          className="text-[0.82rem] font-mono px-2 py-[4px] rounded-md max-w-[150px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
        />
        <input
          type="text"
          value={newIpDesc}
          onChange={(e) => setNewIpDesc(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="Description"
          className="text-[0.82rem] px-2 py-[4px] rounded-md max-w-[160px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
        />
        <Button
          type="submit"
          variant="ghost"
          size="xs"
          loading={addIpMutation.isPending}
          onClick={(e) => e.stopPropagation()}
        >
          Add IP
        </Button>
      </form>

      {/* Assigned DIDs */}
      <div className="text-[0.63rem] font-bold text-[#718096] uppercase tracking-[0.7px] mt-3 mb-2">
        Assigned DIDs
      </div>
      {trunk.dids.length === 0 ? (
        <div className="text-[0.78rem] text-[#718096] py-1">No DIDs assigned</div>
      ) : (
        <div className="flex flex-wrap gap-1.5 mb-1">
          {trunk.dids.map((d) => (
            <span
              key={d.id}
              className="text-[0.75rem] font-mono px-2 py-[2px] bg-[#0d0f15] border border-[#2a2f45] rounded text-[#e2e8f0]"
            >
              {d.did}
            </span>
          ))}
        </div>
      )}
      <form
        onSubmit={handleAddDid}
        onClick={(e) => e.stopPropagation()}
        className="flex gap-2 mt-2 items-center flex-wrap"
      >
        <input
          type="tel"
          value={newDid}
          onChange={(e) => setNewDid(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="+12125551234"
          className="text-[0.82rem] font-mono px-2 py-[4px] rounded-md max-w-[180px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
        />
        <Button
          type="submit"
          variant="ghost"
          size="xs"
          loading={addDidMutation.isPending}
          onClick={(e) => e.stopPropagation()}
        >
          Assign DID
        </Button>
      </form>

      {/* Enable/Disable trunk */}
      <div
        className="mt-3 pt-3 border-t border-[#2a2f45]"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="xs"
          loading={toggleMutation.isPending}
          onClick={(e) => {
            e.stopPropagation();
            toggleMutation.mutate(!trunk.enabled);
          }}
        >
          {trunk.enabled ? 'Disable' : 'Enable'} Trunk
        </Button>
      </div>
    </div>
  );
}

// ----- CustomerTrunkSection -----

interface CustomerTrunkSectionProps {
  customerId: number;
}

export function CustomerTrunkSection({ customerId }: CustomerTrunkSectionProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toastOk, toastErr } = useToast();

  const [newTrunkName, setNewTrunkName] = useState('');
  const [newTrunkAuth, setNewTrunkAuth] = useState<TrunkAuthType>('ip');

  // Fetch trunks list
  const { data: trunksData, isLoading, isError } = useQuery({
    queryKey: ['customerTrunks', customerId],
    queryFn: async () => {
      const list = await listTrunks({ customer_id: customerId, limit: 50 });
      // list is normalised to { items, total } — items is always an array
      const trunkItems = list.items ?? [];
      // For each trunk, fetch IPs and DIDs in parallel
      const withDetails = await Promise.all(
        trunkItems.map(async (trunk) => {
          const [ips, dids] = await Promise.allSettled([
            getTrunkIps(trunk.id),
            getTrunkDids(trunk.id),
          ]);
          return {
            ...trunk,
            ips: ips.status === 'fulfilled' ? ips.value : [],
            dids: dids.status === 'fulfilled' ? dids.value : [],
          } satisfies TrunkWithDetails;
        }),
      );
      return withDetails;
    },
  });

  const createTrunkMutation = useMutation({
    mutationFn: () =>
      createTrunk({
        customer_id: customerId,
        trunk_name: newTrunkName.trim(),
        max_channels: 10,
        cps_limit: 5,
        auth_type: newTrunkAuth,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerTrunks', customerId] });
      setNewTrunkName('');
      setNewTrunkAuth('ip');
      toastOk(`Trunk "${newTrunkName.trim()}" created`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleCreateTrunk(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newTrunkName.trim()) { toastErr('Trunk name is required'); return; }
    createTrunkMutation.mutate();
  }

  const trunks = trunksData ?? [];

  return (
    <div className="pt-4 border-t border-[#2a2f45]">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[0.63rem] font-bold text-[#718096] uppercase tracking-[0.9px]">
          Trunk Configuration
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/trunks'); }}
          className="text-[0.72rem] text-[#3b82f6] hover:underline"
        >
          Manage Trunks
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] text-[0.8rem] py-2">
          <Spinner size="xs" /> Loading trunks…
        </div>
      )}

      {isError && (
        <p className="text-red-400 text-[0.8rem]">Could not load trunks.</p>
      )}

      {!isLoading && !isError && trunks.length === 0 && (
        <p className="text-[#718096] text-[0.8rem]">No trunks configured.</p>
      )}

      {!isLoading &&
        trunks.map((trunk) => (
          <TrunkCard key={trunk.id} trunk={trunk} customerId={customerId} />
        ))}

      {/* Create New Trunk form */}
      <form
        onSubmit={handleCreateTrunk}
        onClick={(e) => e.stopPropagation()}
        className="mt-1 p-3 bg-[#1e2130] border border-[#2a2f45] rounded-lg"
      >
        <div className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-2">
          Create New Trunk
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[0.6px]">
              Trunk Name
            </label>
            <input
              type="text"
              value={newTrunkName}
              onChange={(e) => setNewTrunkName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="acme-primary"
              className="text-[0.83rem] px-2 py-[5px] rounded-lg w-[140px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[0.6px]">
              Auth Type
            </label>
            <select
              value={newTrunkAuth}
              onChange={(e) => setNewTrunkAuth(e.target.value as TrunkAuthType)}
              onClick={(e) => e.stopPropagation()}
              className="text-[0.83rem] px-2 py-[5px] rounded-lg w-[130px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] cursor-pointer"
            >
              <option value="ip">IP Auth</option>
              <option value="credentials">Credential</option>
              <option value="both">Both</option>
            </select>
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={createTrunkMutation.isPending}
            onClick={(e) => e.stopPropagation()}
          >
            Create Trunk
          </Button>
        </div>
      </form>
    </div>
  );
}
