/**
 * Setup / gating helpers for the Call Flow Builder.
 *
 * The builder is "configured" only once a concrete Customer → Product → Line has
 * been chosen — that triple is what defines a flow's real capabilities. These
 * pure predicates are shared by the toolbar (which drives the 1-2-3 setup and
 * gates Save/Publish) and the shell (which gates the palette + canvas behind a
 * guided setup state). Keeping them here avoids duplicating the "is this binding
 * actually pointing at a line?" logic in two places.
 */
import type { CallFlowDoc, EntryBinding, ProductKind } from './types';
import type { AccountType } from '../../types/customer';
import type { RcfEntry } from '../../types/rcf';
import { listRcf } from '../../api/rcf';
import { listApiDids } from '../../api/apiDids';
import { listTrunks } from '../../api/trunks';
import { listExtensions } from '../../api/extensions';
import { fmt } from '../../utils/format';

/**
 * True when the entry binding actually points at a concrete line — i.e. the
 * product-specific identifier is non-empty (`did !== ''`, `trunkId > 0`,
 * `ext !== ''`, `confId !== ''`). An empty binding is the unconfigured default.
 */
export function isEntryBound(entry: EntryBinding): boolean {
  switch (entry.kind) {
    case 'did':
      return entry.did.trim() !== '';
    case 'trunk':
      return entry.trunkId > 0;
    case 'conference':
      return entry.confId.trim() !== '';
    case 'extension':
      return entry.ext.trim() !== '';
    default:
      return false;
  }
}

/**
 * The builder is configured (workspace unlocked) when a customer is selected and
 * the entry binding points at a real line. `product` is always a `ProductKind`
 * on the doc, so the customer + bound-line pair is the meaningful gate.
 */
export function isFlowConfigured(doc: Pick<CallFlowDoc, 'customerId' | 'entry'>): boolean {
  return doc.customerId != null && isEntryBound(doc.entry);
}

/** Stable key for a binding — used as the Line `<select>` value. */
export function entryKey(entry: EntryBinding): string {
  switch (entry.kind) {
    case 'did':
      return entry.did;
    case 'trunk':
      return entry.trunkId > 0 ? String(entry.trunkId) : '';
    case 'conference':
      return entry.confId;
    case 'extension':
      return entry.ext;
    default:
      return '';
  }
}

/** Short human label for a bound line — surfaced prominently in the toolbar. */
export function entryLabel(entry: EntryBinding): string {
  switch (entry.kind) {
    case 'did':
      return entry.did;
    case 'trunk':
      return `Trunk #${entry.trunkId}`;
    case 'conference':
      return `Conf ${entry.confId}`;
    case 'extension':
      return `Ext ${entry.ext}`;
    default:
      return '';
  }
}

/**
 * Products offered in the gated setup cluster for a customer's `account_type`.
 * This is intentionally NARROWER than `SELECTABLE_PRODUCTS`: only products that
 * map to a concrete provisioned line type are offered, and `hybrid` fans out to
 * its three line products. `ivr` / `conference` are never offered here — they
 * don't correspond to a customer line type (the data model keeps them for the
 * New-flow / Import paths).
 */
export function productsForAccountType(at: AccountType | undefined): ProductKind[] {
  switch (at) {
    case 'rcf':
      return ['rcf'];
    case 'api':
      return ['api'];
    case 'trunk':
      return ['trunk'];
    case 'ucaas':
      return ['ucaas'];
    case 'hybrid':
      return ['rcf', 'api', 'trunk'];
    default:
      return [];
  }
}

/* ─── Line source — a customer's provisioned lines for a product ───────────── */

/** One provisioned line a customer can bind a flow to (product-normalised). */
export interface LineOption {
  /** Stable `<option>` value (matches `entryKey(binding)`). */
  key: string;
  /** Display label. */
  label: string;
  /** The entry binding this line compiles to. */
  binding: EntryBinding;
  /**
   * The raw source row for this line, when one is carried. RCF attaches its
   * `RcfEntry` so the commit step can hydrate the canvas from the live config
   * without a refetch. Undefined for products that don't hydrate-from-line.
   */
  raw?: RcfEntry;
}

/**
 * Fetch a customer's provisioned lines for the chosen product, normalised to
 * `LineOption[]`. Each product sources a different list endpoint and binding:
 *   rcf   → listRcf        → did       → { kind:'did', did }
 *   api   → listApiDids    → did       → { kind:'did', did }
 *   trunk → listTrunks     → {id,name} → { kind:'trunk', trunkId }
 *   ucaas → listExtensions → extension → { kind:'extension', ext }
 *
 * Shared by the setup card (the input) and — indirectly, via `entryKey` — the
 * toolbar summary, so the gate's data shape lives in one place.
 */
export async function fetchLines(customerId: number, product: ProductKind): Promise<LineOption[]> {
  switch (product) {
    case 'rcf': {
      const r = await listRcf({ customer_id: customerId });
      return r.items.map((e) => ({ key: e.did, label: fmt(e.did) || e.did, binding: { kind: 'did', did: e.did }, raw: e }));
    }
    case 'api': {
      const r = await listApiDids({ customer_id: customerId });
      return r.items.map((e) => ({ key: e.did, label: fmt(e.did) || e.did, binding: { kind: 'did', did: e.did } }));
    }
    case 'trunk': {
      const r = await listTrunks({ customer_id: customerId });
      return r.items.map((t) => ({
        key: String(t.id),
        label: `${t.trunk_name} · #${t.id}`,
        binding: { kind: 'trunk', trunkId: t.id },
      }));
    }
    case 'ucaas': {
      const r = await listExtensions({ customer_id: customerId });
      return r.map((x) => ({
        key: x.extension,
        label: x.display_name ? `Ext ${x.extension} · ${x.display_name}` : `Ext ${x.extension}`,
        binding: { kind: 'extension', ext: x.extension },
      }));
    }
    default:
      // ivr / conference aren't offered in the gated picker.
      return [];
  }
}
