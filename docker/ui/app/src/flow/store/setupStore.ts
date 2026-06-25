/**
 * Shared SETUP staging store for the Call Flow Builder gate.
 *
 * The builder is gated behind a Customer → Product → Line selection. That choice
 * is made in the centre "Set up this flow" card (`FlowBuilderShell.GuidedSetup`)
 * but must ALSO be mirrored, live, in the top toolbar (`FlowToolbar.SetupSummary`).
 * Two surfaces, one selection — so the staging state can't live in either
 * component's local `useState`. It lives here, in a tiny non-undoable zustand
 * store, so both read/write the same values without prop-drilling.
 *
 * This is deliberately SEPARATE from `flowStore` (the graph/doc store):
 *  - it must not pollute the zundo undo timeline (staging a customer isn't a
 *    graph edit), and
 *  - it carries one piece of pure-UI state — `editing` — that has no place on the
 *    persisted document: the "Change" affordance re-opens the setup card on an
 *    already-configured flow, and the shell reads `editing` to know to show the
 *    card again over the live canvas.
 *
 * Staging is kept in sync with the committed doc by the toolbar: every load /
 * import / commit calls `seed(...)`, and "Change" calls `beginEdit(...)`. The
 * card writes through `setCustomer` / `setProduct` / `setLineKey` as the operator
 * picks, which is what the toolbar summary mirrors.
 */
import { create } from 'zustand';
import type { ProductKind } from '../model/types';

/** A seed snapshot — the committed selection a load/commit reflects into staging. */
export interface SetupSeed {
  customerId: number | null;
  product: ProductKind | null;
  lineKey: string;
}

/**
 * Where the freshly-committed flow's canvas came from — drives the hydration
 * banner. `saved`/`live` show the "review before publishing" bar; `fresh`/`null`
 * show nothing.
 */
export type HydrationSource = 'saved' | 'live' | 'fresh' | null;

export interface SetupState {
  /** Staged customer (drives the allowed product list). */
  customerId: number | null;
  /** Staged product (drives the line query). */
  product: ProductKind | null;
  /** Staged line key — `entryKey(binding)` of the chosen/committed line. */
  lineKey: string;
  /**
   * True when the operator re-opened setup on an ALREADY-configured flow via the
   * toolbar's "Change". The shell renders the setup card (not the canvas) while
   * this holds, even though the doc is configured.
   */
  editing: boolean;
  /**
   * How the current canvas was populated when the line was committed. The shell's
   * hydration banner reads this; `commitLine` sets it after seeding.
   */
  hydratedFrom: HydrationSource;

  /** Pick a customer — clears the dependent product + line. */
  setCustomer: (id: number | null) => void;
  /** Pick a product — clears the dependent line. */
  setProduct: (p: ProductKind | null) => void;
  /** Stage a line key (the final, committing step). */
  setLineKey: (key: string) => void;
  /** Record where the just-committed canvas was hydrated from (banner driver). */
  setHydratedFrom: (source: HydrationSource) => void;

  /** Re-open setup over a configured flow, pre-filling staging from the doc. */
  beginEdit: (seed: SetupSeed) => void;
  /** Close the re-opened setup without changing the selection (Cancel). */
  endEdit: () => void;
  /** Reflect a committed/loaded selection into staging (no edit mode). */
  seed: (seed: SetupSeed) => void;
  /** Blank the staging entirely (e.g. New flow). */
  reset: () => void;
}

export const useSetupStore = create<SetupState>((set) => ({
  customerId: null,
  product: null,
  lineKey: '',
  editing: false,
  hydratedFrom: null,

  setCustomer: (id) => set({ customerId: id, product: null, lineKey: '' }),
  setProduct: (p) => set({ product: p, lineKey: '' }),
  setLineKey: (key) => set({ lineKey: key }),
  setHydratedFrom: (source) => set({ hydratedFrom: source }),

  // Loads/imports clear any prior hydration source; commitLine sets it explicitly
  // after seeding, so an unrelated load never leaves a stale banner behind.
  beginEdit: (seed) => set({ ...seed, editing: true }),
  endEdit: () => set({ editing: false }),
  seed: (seed) => set({ ...seed, editing: false, hydratedFrom: null }),
  reset: () => set({ customerId: null, product: null, lineKey: '', editing: false, hydratedFrom: null }),
}));
