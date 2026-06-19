# Universal Call Flow Builder — Design Plan

**Status:** Design / research only (no implementation in this doc)
**Branch:** `unified`
**UI root:** `docker/ui/app/`
**Author:** frontend-fullstack-expert
**Date:** 2026-06-19

---

## 0. TL;DR

Build one best-in-class, node-graph **Call Flow Builder** (think n8n / Twilio
Studio polish) that is the single editing surface for call-handling logic across
every revup product where a "what happens when a call arrives" graph makes sense
— IVR/programmable-voice first, then RCF, then trunk/API/conferencing/UCaaS.

- **Canvas:** migrate off the `@dnd-kit` tree list (`pages/ivr/`) to a real
  node-graph canvas — **React Flow (`@xyflow/react` v12, MIT)**.
- **Model:** one portable JSON graph (`CallFlowDoc` = `nodes[] + edges[]`,
  Twilio-Studio-style **states + transitions**) that is the **single source of
  truth**. A per-product **compiler** turns that graph into the right backend
  artifact (IVR → the existing TwiML in `ivr_flows.flow_config`; RCF →
  `rcf_numbers` columns; trunk → routing rules; API → webhook TwiML).
- **Abstraction:** a *call flow* = what happens when a call hits an entry point.
  A *product* = **entry point + allowed node palette + compile target**. Same
  editor, different palette/compiler bindings.
- **Phasing:** ship React Flow + IVR-compiles-to-existing-XML first (proves the
  model end-to-end against a runtime we already have), then RCF, then the rest.

The three decisions to weigh in on are at the very bottom (§11).

---

## 1. Recommended Package Stack

All MIT-licensed. Versions are current as of 2026-06.

| Package | Version | License | Why |
|---|---|---|---|
| `@xyflow/react` | `^12.11` | MIT | The node-graph canvas. De-facto industry standard for React node UIs; custom nodes/edges, typed handles, MiniMap, Controls, Background, viewport, selection, validation hooks (`isValidConnection`), `onlyRenderVisibleElements`. |
| `@dagrejs/dagre` | `^1.1` | MIT | Auto-layout for directed trees. Drop-in, synchronous, fast — ideal for "tidy up" and for importing the existing nested IVR trees into graph coordinates. |
| `elkjs` | `^0.9` | EPL-2.0* | Optional, Phase 3+. Far more configurable (orthogonal edge routing, port ordering) for dense flows. Async. Add only when dagre's tree layout is no longer enough. |
| `zustand` | `^5` | MIT | App-level flow store. React Flow already uses zustand internally, so this is the idiomatic pairing. Replaces the current `useReducer`. |
| `zundo` | `^2` | MIT | ~700 byte temporal middleware for zustand → undo/redo for free (snapshots `nodes`/`edges`, with `handleSet` debouncing for drags). |
| `nanoid` | `^5` | MIT | Collision-resistant node/edge ids. Replaces `Math.random().toString(36)` in `makeNode`. |

\* **License flag:** `elkjs` is EPL-2.0 (weak copyleft, fine for use as an
unmodified dependency, but legal should sign off before we ship it). Everything
else is MIT. **dagre alone covers the MVP** — elkjs is deferred, so the MVP ships
100% MIT.

**Removed / no longer needed for the builder:** `@dnd-kit/core` +
`@dnd-kit/sortable`. The palette → canvas drop becomes React Flow's
`onDrop`/`onDragOver` + native HTML5 DnD. `@dnd-kit` can stay in `package.json`
if any other page uses it, but the IVR builder stops depending on it.

**Why React Flow over the alternatives** (grounded in current research):

- **React Flow / `@xyflow/react`** — purpose-built for React, MIT, actively
  developed (v12.11, 2026 releases added auto-pan, connection radius, better
  touch, AI-builder tooling). Custom nodes are plain React components; handles +
  edges model telephony branching exactly (one source handle per Menu digit).
  This is what modern flow/AI builders standardize on.
  ([npm](https://www.npmjs.com/package/@xyflow/react),
  [reactflow.dev](https://reactflow.dev/))
- **Rete.js** — framework-agnostic (React/Vue/Angular/Svelte/Lit) with a
  dataflow/control-flow *execution engine*. The execution engine is the wrong
  fit: our flows execute server-side (FreeSWITCH/Lua + the API), not in the
  browser. We'd fight its engine abstractions and lose React-native ergonomics.
  ([retejs.org](https://retejs.org/docs/))
- **Drawflow** — vanilla-JS, lightweight, but no first-class React story, weaker
  custom-node/typing ergonomics, smaller ecosystem. A step backward from where we
  already are with typed React components.
- **Litegraph.js** — game/shader-graph heritage, canvas-rendered (not DOM), poor
  fit for form-heavy telephony config panels and accessibility.
- **react-dnd / `@dnd-kit` only** — what we have today. These are list/tree DnD
  primitives, **not** a node canvas: no edges, no pan/zoom, no handles, no
  minimap. You can *fake* a graph but you reimplement everything React Flow gives
  for free. Migrate.

**Recommendation: adopt React Flow; retire the `@dnd-kit` tree.**
([comparison sources](https://npmtrends.com/drawflow-vs-litegraph.js-vs-react-flow-vs-rete),
[jointjs/jsplumb alt pages](https://jsplumbtoolkit.com/reactflow-alternative))

---

## 2. The Unified, Product-Agnostic Data Model

### 2.1 Why a graph, not a tree

The current builder (`pages/ivr/`) stores a **nested tree**: each `BuilderNode`
owns `prompt: BuilderNode[]` and `branches: Record<string, BuilderNode[]>`
(`ivrUtils.ts`). That is a tree, not a graph — you cannot have two menu options
converge on the same "transfer to sales" node, cannot draw loops/go-tos, and the
Python runtime already papers over this by emitting *branch routing as XML
comments* (`nodesToXml`) and serving branches through separate webhook calls
(`/ivr/webhook/{flow_id}` + `gather_id`).

A real call flow is a **directed graph**. We adopt the Twilio Studio model
(validated against their Flow Definition schema): a flat **`states` array** with
**`transitions`** that reference other states **by name/id on an event**, plus an
**`initial_state`**. ([Twilio Flow Definition](https://www.twilio.com/docs/studio/rest-api/v2/flow-definition),
[Widget Library](https://www.twilio.com/docs/studio/widget-library)). Amazon
Connect contact flows and n8n use the same "blocks + typed connections" shape.

### 2.2 `CallFlowDoc` — the single source of truth

This JSON is what we store, version, undo/redo, import/export, and compile. It
maps cleanly to React Flow's `nodes`/`edges` (positions live here so the canvas
is fully reconstructable) **and** is product-agnostic.

```ts
// src/flow/model/types.ts  (proposed)

export type ProductKind =
  | 'ivr'        // programmable voice (the rich TwiML runtime we already have)
  | 'rcf'        // remote call forwarding
  | 'trunk'      // SIP trunk inbound routing
  | 'api'        // API calling (webhook-driven voice)
  | 'conference' // conference entry flow
  | 'ucaas';     // find-me/follow-me, voicemail fallback

export type NodeType =
  | 'entry'      // the single trigger / call-arrives node (one per flow)
  | 'answer' | 'say' | 'play' | 'pause'
  | 'menu'       // Gather: collect digits, branch per digit
  | 'dial'       // Dial/Forward to a PSTN/SIP destination
  | 'ringGroup'  // ring N destinations simultaneously/sequentially
  | 'schedule'   // time-of-day / holiday routing
  | 'condition'  // generic branch (caller-id, variable, %-split)
  | 'record' | 'voicemail' | 'conference' | 'queue'
  | 'webhook'    // HTTP call out, branch on response
  | 'goto'       // jump to another node (loops, shared subtrees)
  | 'reject' | 'hangup';

export interface FlowNode<C = NodeConfig> {
  id: string;                       // nanoid
  type: NodeType;
  position: { x: number; y: number };
  data: {
    label?: string;                 // user-facing name
    config: C;                      // typed per NodeType (discriminated union)
  };
}

export interface FlowEdge {
  id: string;
  source: string;                   // node id
  sourceHandle?: string | null;     // which outcome: 'next' | digit '1'..'#' |
                                    // 'timeout' | 'noMatch' | 'busy' | 'noAnswer'
  target: string;
  data?: { label?: string; condition?: EdgeCondition };
}

export interface CallFlowDoc {
  schemaVersion: 1;
  id: number | null;                // persisted flow id (null = unsaved)
  product: ProductKind;             // selects palette + compiler
  name: string;
  customerId: number | null;
  entry: EntryBinding;              // see §2.3
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport?: { x: number; y: number; zoom: number };
  status: 'draft' | 'published';
  version: number;
  updatedAt?: string;
}
```

`NodeConfig` is a **discriminated union keyed on `type`** (the TS pattern this
codebase already favors), e.g.:

```ts
type NodeConfig =
  | { type: 'say';  text: string; voice: string; language?: string }
  | { type: 'menu'; numDigits: number; timeout: number; finishOnKey?: string }
  | { type: 'dial'; number: string; callerId?: string; timeout: number;
      record?: boolean }
  | { type: 'ringGroup'; members: string[]; strategy: 'simul' | 'sequential';
      timeout: number }
  | { type: 'schedule'; tz: string; rules: ScheduleRule[] }
  // ...one arm per NodeType
```

Branching that used to be nested children (`branches`) is now **edges off typed
source handles**. A `menu` node renders one output handle per configured digit,
plus `timeout` and `noMatch`. Two menu options can converge on the same `dial`
node — impossible in the old tree. `goto` enables loops/shared subtrees.

### 2.3 Entry binding — the product seam

```ts
type EntryBinding =
  | { kind: 'did';      did: string }            // ivr / api / rcf
  | { kind: 'trunk';    trunkId: number }        // trunk inbound
  | { kind: 'conference'; confId: string }       // conference entry
  | { kind: 'extension'; ext: string };          // ucaas find-me/follow-me
```

**This is the whole abstraction:** the *flow* is identical machinery; the
*product* is `(entry binding) + (palette subset) + (compile target)`. One editor,
six bindings.

### 2.4 Compilation — graph in, product artifact out

The graph is the **source**; each product has a pure **compiler** that walks the
graph from `entry` and emits the backend's native artifact. Compilers live
client-side first (mirroring how `ivrUtils.nodesToXml` already runs in the
browser for preview), and the *same* compiler logic can later move server-side
for authoritative validation.

```ts
interface FlowCompiler<TArtifact> {
  product: ProductKind;
  validate(doc: CallFlowDoc): ValidationResult;   // §6
  compile(doc: CallFlowDoc): TArtifact;            // graph → backend shape
}
```

| Product | Compile target (artifact) | Backend sink |
|---|---|---|
| `ivr` | Nested IVR tree (`{nodes:[{type,config,prompt,branches}]}`) **and/or** TwiML XML | `ivr_flows.flow_config` (existing `ivr.py` runtime, unchanged) |
| `api` | Same as IVR (webhook TwiML) | `api_dids.voice_url` → `/ivr/webhook/{id}` (existing) |
| `rcf` | `{forward_to, failover_to, ring_timeout, pass_caller_id}` | `rcf_numbers` columns (existing) — see §3 scope note |
| `trunk` | Inbound routing ruleset (DID → action / LCR order) | New (Phase 4) — flag for backend |
| `conference` | Conference entry TwiML / room config | `ivr_flows`-style or conference table (Phase 3) |
| `ucaas` | Find-me/follow-me ring plan | UCaaS extension config (Phase 4) |

**Key compatibility win:** the IVR compiler emits the **exact nested-tree shape
`ivr.py` already consumes** (`flow_config.nodes[*].{type,config,prompt,branches}`
— see `generate_xml`/`_node_to_xml`/`_find_gather_node`). So Phase 1 ships with
**zero runtime backend changes**: we graph-edit, compile to the legacy tree, POST
to `PUT /ivr/{id}`, and FreeSWITCH's `api_voice.lua` keeps serving it. The graph
itself is stored alongside (see §7) as the editable source of truth.

---

## 3. Per-Product Node Catalog (Palette Matrix)

Each product exposes a subset of node types. ✅ = in palette, ⛔ = hidden,
🔶 = available but requires a backend/runtime extension before it does anything.

| Node | ivr | api | rcf | trunk | conf | ucaas | Notes |
|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| `entry` (Trigger) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Exactly one per flow. |
| `answer` | ✅ | ✅ | ⛔ | ⛔ | ✅ | ⛔ | |
| `say` (TTS) | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | Runtime: Piper via `tts_commandline` (`api_voice.lua`). |
| `play` (audio URL) | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | |
| `pause` | ✅ | ✅ | ⛔ | ⛔ | ✅ | ⛔ | |
| `menu` (Gather) | ✅ | ✅ | ⛔ | ⛔ | ⛔ | 🔶 | Maps to `<Gather>` + branch edges. |
| `dial` / forward | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | RCF's core verb. |
| `ringGroup` | ✅ | ✅ | 🔶 | ⛔ | ⛔ | ✅ | RCF needs runtime ext (Lua bridges single dest today). |
| `schedule` (time-of-day) | ✅ | ✅ | 🔶 | ✅ | ⛔ | ✅ | Branch on tz/hours/holidays. RCF ext. |
| `condition` (branch) | ✅ | ✅ | 🔶 | ✅ | ⛔ | ✅ | Caller-ID / variable / %-split. |
| `record` | ✅ | ✅ | ⛔ | ⛔ | ⛔ | ✅ | `api_voice.lua` Phase-6 recording. |
| `voicemail` | 🔶 | 🔶 | 🔶 | ⛔ | ⛔ | ✅ | UCaaS feature; not RCF-V1 scope. |
| `conference` | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | |
| `queue` | 🔶 | 🔶 | ⛔ | ⛔ | ⛔ | 🔶 | Future. |
| `webhook` (HTTP) | ✅ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | Branch on response. |
| `goto` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Loops / shared targets. |
| `reject` | ✅ | ✅ | ⛔ | ✅ | ⛔ | ⛔ | |
| `hangup` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Terminal. |

> **RCF scope guardrail.** Per the project's hard rule (*RCF must stay simple —
> RCF customers never see UCaaS features*), the **RCF palette MVP is
> deliberately minimal**: `entry → dial → (failover) → hangup`, which compiles
> 1:1 into the existing `rcf_numbers` columns (`forward_to`, `failover_to`,
> `ring_timeout`, `pass_caller_id`). The 🔶 RCF nodes (`ringGroup`, `schedule`,
> `condition`) are the *upsell* described in the brief but each needs a Lua +
> schema extension first — they are explicitly Phase 2 and gated behind a backend
> decision (§11.2). This keeps a vanilla RCF customer's flow a two-node line, not
> a programmable-voice canvas.

---

## 4. Architecture & State

### 4.1 Component breakdown

New home: `src/flow/` (product-agnostic), replacing `src/pages/ivr/`.

```
src/flow/
  FlowBuilderPage.tsx        Route shell; reads :product + :flowId; owns React Query
  FlowBuilderShell.tsx       Layout: toolbar / palette / canvas / config / validation
  canvas/
    FlowCanvas.tsx           <ReactFlow> host: nodes, edges, MiniMap, Controls, Background
    nodeTypes.tsx            Registry: NodeType -> custom React node component
    edgeTypes.tsx            Labeled/conditional edges
    nodes/                   One component per NodeType (SayNode, MenuNode, DialNode…)
    handles.ts               Per-node output handle definitions (digits/timeout/noMatch…)
  palette/
    NodePalette.tsx          Product-filtered draggable node list (HTML5 DnD -> onDrop)
  config/
    NodeConfigPanel.tsx      Selected-node editor (evolves IvrConfigPanel patterns)
    fields/                  Reusable typed field editors (reuse src/components/ui/FormField)
  validation/
    ValidationPanel.tsx      Live rule results; click-to-focus the offending node
  toolbar/
    FlowToolbar.tsx          Name, product/DID binding, undo/redo, autosave status,
                             Validate, Simulate, Preview-compiled, Publish
  versions/
    VersionHistory.tsx       Draft vs published, restore a version
  simulate/
    SimulatePanel.tsx        Step-through "what would happen" preview (§6)
  store/
    flowStore.ts             zustand + zundo: { doc, nodes, edges, selected, ... }
    selectors.ts
  model/
    types.ts                 CallFlowDoc, FlowNode, FlowEdge, NodeConfig (discriminated)
    defaults.ts              makeNode(type) (replaces ivrUtils.makeNode + nanoid)
  compile/
    ivr.ts                   graph -> nested IVR tree / TwiML  (reuses ivrUtils logic)
    rcf.ts                   graph -> rcf_numbers fields
    trunk.ts conference.ts api.ts ucaas.ts
    registry.ts              ProductKind -> { palette, compiler, validators }
  import/
    fromLegacyIvr.ts         nested flow_config -> CallFlowDoc (+ dagre auto-layout)
```

### 4.2 State management

- **Canvas state** lives in React Flow (it manages selection, drag, viewport,
  connection interactions via its internal zustand store).
- **Authoritative doc** lives in an **app zustand store** (`flowStore`). `nodes`
  and `edges` are stored here; `onNodesChange`/`onEdgesChange`/`onConnect`
  forward React Flow's change events into the store via `applyNodeChanges` /
  `applyEdgeChanges` / `addEdge`. The store is the serializable `CallFlowDoc`.
- **Why zustand over the current `useReducer`:** React Flow is itself
  zustand-based, so this is the idiomatic integration; and `zundo` gives
  **undo/redo** as a 3-line middleware wrap (snapshots `nodes`/`edges`;
  `handleSet` debounce so a drag is one history entry, not 200). The existing
  `IvrAction` reducer model is good design but does not give undo/redo, graph
  edges, or convergence — it's a tree mutator. We evolve, not discard: the
  typed-action discipline carries over as typed store actions.

```ts
// store/flowStore.ts  (sketch)
const useFlowStore = create<FlowState>()(
  temporal(                              // zundo: undo/redo
    (set, get) => ({
      doc, nodes, edges, selectedId,
      onNodesChange: (c) => set({ nodes: applyNodeChanges(c, get().nodes) }),
      onEdgesChange: (c) => set({ edges: applyEdgeChanges(c, get().edges) }),
      onConnect:     (c) => set({ edges: addEdge(c, get().edges) }),
      updateConfig:  (id, patch) => set(/* immutable merge into node.data.config */),
      // ...typed actions, mirrors today's IvrAction surface
    }),
    { partialize: (s) => ({ nodes: s.nodes, edges: s.edges }),
      handleSet: (fn) => debounce(fn, 300) },   // one undo step per gesture
  ),
);
```

### 4.3 Autosave + serialize/deserialize

- **Serialize:** `CallFlowDoc` *is* the wire format — `JSON.stringify(doc)`. No
  separate serializer needed (unlike today, where the tree must be flattened for
  the API).
- **Autosave:** debounced (1–2s) React Query mutation to `PUT /ivr/{id}` (or the
  generalized endpoint, §7) whenever the store changes and the flow is a saved
  **draft**. Toolbar shows "Saving… / Saved / Error" (reuse the `useToast`
  pattern). First save (no id) is explicit, like today's `Save Flow`.
- **Deserialize:** load `CallFlowDoc` straight into the store. For **legacy**
  flows (existing `ivr_flows.flow_config` nested trees), run
  `import/fromLegacyIvr.ts` → produces nodes/edges, then **dagre auto-layout** to
  assign coordinates, so every already-saved IVR opens in the new canvas.

### 4.4 React Query keys

Follow §6 of `docker/ui/CLAUDE.md`. Add `['flows', { product, customerId }]` and
`['flow', flowId]`; reuse `['ivr-flows']` during the transition.

---

## 5. Coexist vs Replace — the path

**Recommendation: REPLACE `src/pages/ivr/` with `src/flow/`, reusing its proven
parts; keep the `ivr.py` runtime untouched.**

What we **keep / lift wholesale** (these are good and battle-tested):
- `ivrUtils.ts` XML emission (`nodesToXml`, `escXml`, `highlightXml`) → becomes
  the tail end of `compile/ivr.ts`.
- `IvrConfigPanel.tsx` field patterns and `IvrXmlModal` preview → `config/` +
  a generic "Preview compiled artifact" modal.
- The discriminated-union, typed-action discipline of `useIvrFlow.ts`.
- The whole `ivr.py` backend + `api_voice.lua` runtime — **unchanged**.

What we **retire**:
- `@dnd-kit` tree DnD, `IvrCanvas`/`IvrDropZone`/`IvrGatherBranches` (tree render),
  the nested `BuilderNode.prompt/branches` structure as the *editing* model.

Migration safety: a one-time `fromLegacyIvr` importer means no saved flow is
stranded. The IVR compiler round-trips back to the legacy tree, so a flow edited
in the new builder still serves through the old runtime — we can ship the new
editor without a backend cutover.

---

## 6. Telephony-Grade UX

### 6.1 Live validation rules (per-product `validate()`)

Run on every store change, surfaced in `ValidationPanel` (click a finding →
canvas pans to and highlights the node). Rules:

**Universal**
- Exactly **one `entry`** node; it has exactly one outgoing edge.
- **No orphan nodes** (every non-entry node reachable from `entry`).
- **No dangling required outputs** (a handle that *must* be connected isn't).
- **Terminal coverage:** every path ends in a terminal (`hangup`/`dial`/`voicemail`/
  `reject`/`conference`) — no path "falls off the end".
- **No invalid loops** without a `goto`/guard (prevent infinite TwiML redirect
  loops — `api_voice.lua` already caps `MAX_REDIRECT_DEPTH=10`; surface it in UI).

**`menu` (Gather)**
- ≥1 digit branch **and** a `timeout`/`noMatch` path (no dead air on no-input).
- No duplicate digit handles; warn if `finishOnKey` collides with a mapped digit.

**`dial` / `ringGroup`**
- Destination is valid E.164 or SIP/extension (reuse `utils/format.ts` `fmt` +
  the rcf.py validation contract: E.164 or 3–6 digit ext).
- `timeout` within runtime bounds (RCF `ring_timeout` 5–120s per `rcf.py`).

**`schedule`** — rules cover 24h with a default/else branch (no uncovered time).

**Product caps** — block nodes not in the product palette (defense in depth even
though the palette hides them), e.g. a `webhook` in an RCF flow is an error.

### 6.2 Test / simulate / preview

- **Preview compiled artifact:** modal showing the exact `compile()` output
  (TwiML XML with syntax highlighting via existing `highlightXml`, or the
  `rcf_numbers` field diff). This is the trust-building "show me what this
  becomes" view — evolves `IvrXmlModal`.
- **Simulate (step-through):** a `SimulatePanel` that walks the graph as a
  pretend call — operator picks DTMF at each `menu`, the active node highlights
  on canvas, a transcript accrues ("Say: 'Welcome' → Gather → pressed 1 → Dial
  +1…"). Pure client-side graph walk; no calls placed. This is the n8n/Twilio
  "test" affordance and catches routing mistakes pre-publish.
- **Live preview against runtime (later):** for IVR/API, hit
  `GET /ivr/{id}/xml` to diff our client compile vs server output.

### 6.3 Versioning: draft vs published

- `status: 'draft' | 'published'` + `version` on the doc. Editing always mutates
  a **draft**; **Publish** promotes the compiled artifact to what the runtime
  serves. This protects live call routing from half-finished edits — critical for
  a carrier-grade DID handling thousands of calls.
- `VersionHistory` lists prior published versions with restore. Minimal backend:
  a `flow_versions` row or a JSONB array column (§7) — flag for backend.

### 6.4 Tie-in to live calls / SIP ladder

- From a published flow, deep-link to `/troubleshooting` (the native SIP-trace
  page) filtered by the flow's DID, so an operator can see a real call traverse
  the flow they built and jump into the `<SipLadder>` diagram.
- Future: overlay live counts on edges (how many calls took digit "1" in the last
  hour) by joining CDR/`gather` data onto edge ids — the graph ids make this a
  straightforward aggregation. Builds on the existing ESL live-call registry +
  `/calls` plumbing.

---

## 7. Backend Implications (minimal — flag for python-backend-architect)

**Design intent: minimize backend change; reuse `ivr_flows` and the existing
runtime for the MVP.** The graph is additive metadata; the compiled artifact is
unchanged.

**Phase 1 (IVR/API) — smallest possible change:**
- Add columns to `ivr_flows`: `flow_graph JSONB` (the editable `CallFlowDoc` —
  source of truth), `status VARCHAR DEFAULT 'draft'`, `version INT DEFAULT 1`.
  `flow_config` continues to hold the **compiled** nested tree the runtime reads.
  Provision via a new `init/NN_schema_flow_graph.sql` migration with `GRANT`s to
  `api` (the existing `ivr_flows` migration `23_schema_ivr.sql` is the template;
  remember least-privilege — `api` has no CREATE on `public`).
- `ivr.py` CRUD: accept/return `flow_graph` alongside `flow_config`. The webhook
  runtime (`/ivr/webhook/{id}`, `/ivr/{id}/xml`) is **untouched** — it keeps
  reading `flow_config`.

**Phase 2 (RCF):** the RCF compiler writes existing `rcf_numbers` columns via the
existing `/rcf` endpoints — **no new columns** for the minimal `entry→dial→
failover` flow. The 🔶 RCF features (ring groups, schedule, condition) **do**
need new columns + Lua runtime work — explicitly out of MVP, gated on §11.2.

**Phase 3+ (generalization, optional):** if we want a truly product-agnostic
store, introduce a `call_flows` table (`id, product, customer_id, entry JSONB,
flow_graph JSONB, compiled JSONB, status, version, timestamps`) and migrate
`ivr_flows` into it as `product='ivr'`. **Recommendation: do NOT do this for the
MVP** — additively extending `ivr_flows` ships faster and keeps the proven
runtime. Generalize only once a 2nd product (trunk/conference) actually needs its
own compiled sink. This is decision §11.1.

**Versioning:** add `flow_versions(flow_id, version, graph JSONB, compiled JSONB,
published_at)` when §6.3 lands. Trivial, append-only.

Everything backend-side is a **flag for python-backend-architect**, not work in
this plan.

---

## 8. Performance, Accessibility, Risks

**Performance**
- Memoize custom node components (`React.memo`) and pass stable `nodeTypes`/
  `edgeTypes` object identities (React Flow re-renders hard otherwise).
- `onlyRenderVisibleElements` for large flows; defer MiniMap rendering.
- Keep config-panel form state local to the panel; commit to the store on
  blur/debounce so typing doesn't thrash the whole canvas (and doesn't spam
  undo history — `handleSet` debounce).
- Telephony flows are usually 10–60 nodes (not thousands), so this is comfortably
  within React Flow's envelope; the dense case is auto-generated trunk LCR tables
  (Phase 4) — that's where elkjs earns its place.

**Accessibility (carrier ops tooling — real requirement)**
- React Flow has keyboard node selection/movement and ARIA on nodes, but an
  infinite canvas is inherently hard for screen readers. Provide a
  **node-list / outline fallback** (a navigable tree view of the same doc) and
  ensure the **config panel and validation panel are fully keyboard/AT
  accessible** — that's where the real editing happens.
- **Honor the project's hooks rule (`docker/ui/CLAUDE.md` §13, React #310):** in
  every custom node and panel, **all hooks before any early return**. Node
  components conditionally render by type — easy to trip this. Lint with
  `eslint-plugin-react-hooks`.
- Respect the existing dark design tokens (§15) and per-product accent colors
  (RCF `#4ade80`, trunk `#fbbf24`, API `#c084fc`, IVR `#22d3ee`) for node
  theming, so the builder feels native to the app.

**Top risks** (full decision framing in §11)
1. **Storage shape** — extend `ivr_flows` vs new `call_flows` table; dual storage
   (graph source + compiled artifact). Getting this wrong means a painful
   migration later.
2. **RCF scope creep** vs the "RCF stays simple" rule — a graph editor *invites*
   ring groups/time-of-day that the RCF Lua runtime + schema don't support today.
3. **Replace cost & polish budget** — retiring `@dnd-kit`, migrating saved flows,
   and hitting n8n/Twilio-grade visual quality is real effort; needs sign-off.

**Process guardrails** (from project memory): `tsc --noEmit` before any push
(unused imports break the Docker build); do not push until tested locally; type
everything (no `any`), discriminated unions for `NodeConfig`.

---

## 9. Phased Build Plan

**Phase 0 — Foundations (model + scaffolding)**
- Add deps (§1). Define `model/types.ts`, `store/flowStore.ts` (zustand+zundo),
  `compile/registry.ts`. Build `import/fromLegacyIvr.ts` + dagre auto-layout.
- Bare `FlowCanvas` rendering nodes/edges, pan/zoom, MiniMap, Controls.

**Phase 1 — IVR MVP (prove the model end-to-end)** ⭐ *first ship*
- Full IVR palette, custom nodes, config panels, `menu` digit handles + edges.
- `compile/ivr.ts` → legacy nested tree → `PUT /ivr/{id}` (runtime unchanged).
- Validation (§6.1), Preview-compiled (TwiML), undo/redo, autosave drafts.
- Backend: additive `flow_graph/status/version` columns on `ivr_flows`.
- Wire `IvrBuilderPage` (today a "Phase 2" placeholder) to the new builder.
- **Exit criterion:** build an IVR on the canvas, publish, place the live test DID
  (+16174544217), hear it route — using the existing FreeSWITCH/Lua runtime.

**Phase 2 — RCF**
- Minimal RCF palette (`entry→dial→failover→hangup`) → `compile/rcf.ts` →
  `rcf_numbers` via `/rcf`. No schema change.
- *Optional, gated (§11.2):* ring groups / time-of-day / condition → requires Lua
  + schema extension (separate backend epic).

**Phase 3 — API calling + Conferencing**
- API: reuse the IVR compiler (webhook TwiML) with the API palette + DID binding.
- Conference entry flow → conference compile target.

**Phase 4 — Trunk + UCaaS (+ elkjs)**
- Trunk inbound routing / LCR (dense flows → adopt elkjs orthogonal layout).
- UCaaS find-me/follow-me, voicemail fallback (UCaaS-gated accounts only).
- Optional `call_flows` generalization if a distinct compiled sink demands it.

---

## 10. Borrowed Patterns (what comparable products teach us)

- **Twilio Studio** — flat `states[] + initial_state + transitions(event,next,
  conditions)`; "Show Flow JSON" + import-from-JSON. We mirror this exactly
  (our `nodes/edges/entry`), giving free import/export and a clean compile seam.
  ([flow-definition](https://www.twilio.com/docs/studio/rest-api/v2/flow-definition))
- **Amazon Connect** — blocks with typed output branches (success/error/timeout);
  reinforces per-handle outcome modeling (`busy`/`noAnswer`/`timeout`/`noMatch`).
- **n8n** — node palette + typed connections + per-node config drawer + a "test"
  run; sets the polish bar and the simulate UX (§6.2).
- **Vonage / generic CPaaS** — verb-per-node TwiML-like compile; validates the
  "graph is source, XML is artifact" split we already half-have in `ivrUtils`.

---

## 11. Decisions for the Product Owner (please weigh in)

**11.1 — Storage shape (extend vs generalize).**
Recommended: **additively extend `ivr_flows`** (`flow_graph`/`status`/`version`)
for Phase 1–3, keeping the proven runtime; introduce a generalized `call_flows`
table only when a second product needs its own compiled sink (Phase 4). Accept
the dual-storage pattern (graph = source of truth, `flow_config` = compiled
artifact the runtime serves)? Or invest in the generalized table up front?

**11.2 — RCF richness vs "RCF stays simple."**
The vision wants RCF to gain time-of-day routing, failover chains, and ring
groups — but the RCF runtime today is a single-destination Lua bridge writing
`rcf_numbers`. Do we (a) ship **RCF-minimal** (`entry→dial→failover`, zero
backend change) and defer the rich features to a funded "RCF runtime" epic, or
(b) commit now to extending the Lua router + schema so the rich RCF nodes
actually execute? This directly tensions the project's "RCF must stay simple"
rule.

**11.3 — Replace scope, migration & polish budget.**
Approve **retiring the `@dnd-kit` tree builder** and migrating existing saved
IVR flows via the legacy importer? And confirm the budget for n8n/Twilio-grade
visual polish (custom node design, minimap, simulate mode, version history) —
this is the difference between "a canvas" and "best-in-class."

---

## Sources

- React Flow / `@xyflow/react` — [npm](https://www.npmjs.com/package/@xyflow/react),
  [reactflow.dev](https://reactflow.dev/),
  [GitHub releases](https://github.com/xyflow/xyflow/releases)
- Library comparison — [npm trends](https://npmtrends.com/drawflow-vs-litegraph.js-vs-react-flow-vs-rete),
  [Rete.js docs](https://retejs.org/docs/),
  [React Flow alternative (jsPlumb)](https://jsplumbtoolkit.com/reactflow-alternative)
- Auto-layout — [React Flow layouting overview](https://reactflow.dev/learn/layouting/layouting),
  [Dagre example](https://reactflow.dev/examples/layout/dagre),
  [elkjs example](https://reactflow.dev/examples/layout/elkjs),
  [Save & Restore](https://reactflow.dev/examples/interaction/save-and-restore)
- Flow modeling — [Twilio Flow Definition](https://www.twilio.com/docs/studio/rest-api/v2/flow-definition),
  [Twilio Widget Library](https://www.twilio.com/docs/studio/widget-library),
  [Twilio Flow/Widget JSON Schemas](https://www.twilio.com/docs/studio/rest-api/v2/schemas)
