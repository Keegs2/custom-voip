import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistProposal, Flow, IvrGraph } from '../../types/ivr';
import { IvrWorkspaceContext, type IvrWorkspace } from '../../pages/ivr/IvrContext';
import { ivrStaffScope } from '../../pages/ivr/ivrData';
import { createFlowStore, FlowStoreContext, type FlowStore } from '../store/flowStore';
import { BuilderDataContext, type BuilderData } from '../BuilderData';
import { callingOrder, tidyLayout } from '../model/layout';
import { fromGraph, toGraph } from '../model/graph';
import { acceptedGraph } from './model';
import { conversationReducer, initialConversation, type ConversationState } from './conversation';
import { DISCLOSURE, GUIDE_EXAMPLES, GUIDE_LIMITS, VOCABULARY } from './guide';
import { KeywordGuide } from './KeywordGuide';
import { AssistPanel } from './AssistPanel';
import { ProposalBanner } from './ProposalBanner';
import { AssistProvider, type FlowAssistant } from './useFlowAssistant';

// ═════════════════════════════════════════════════════════════════════════════
// assistUi.assert.ts — the Flow assistant's store action and rendering:
//   - the builder store: a proposal preview never touches the draft, its
//     blocks are revealed one at a time in calling order, and replaceDraft()
//     (Accept) is ONE undoable edit that autosave writes — undo restores the
//     previous draft; load() by contrast is "already saved";
//   - the "What can I say?" guide renders the contract's examples as buttons,
//     the panel shows the disclosure above the message box, the banner shows
//     a proposal's new messages with Listen and the four choices.
//
// It imports .tsx components and React Flow, so it runs through Vite's SSR
// loader (no browser, no extra dependency):  node scripts/run-ivr-tests.mjs
// ═════════════════════════════════════════════════════════════════════════════

let passed = 0;

function check(what: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`[ivr assist ui] ${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  passed += 1;
}

const at = { x: 0, y: 0 };

const DRAFT: IvrGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 'n_start', type: 'entry', position: { x: 0, y: 0 }, data: { config: {} } },
    { id: 'n_old', type: 'play', position: { x: 320, y: 0 }, data: { label: 'Old greeting', config: { prompts: [7] } } },
  ],
  edges: [{ id: 'e_old', source: 'n_start', sourceHandle: 'next', target: 'n_old' }],
};

const PROPOSAL_GRAPH: IvrGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 'n_start', type: 'entry', position: at, data: { config: {} } },
    { id: 'n_hi', type: 'play', position: at, data: { label: 'Greeting', config: { prompts: [-1] } } },
    { id: 'n_menu', type: 'menu', position: at, data: { label: 'Main menu', config: { prompts: [-2], digits: ['1', '2'], timeoutSec: 5, retries: 1 } } },
    { id: 'n_bill', type: 'dial', position: at, data: { config: { target: { kind: 'own', did: '+16175550100' }, passCallerId: true, ringTimeoutSec: 30 } } },
    { id: 'n_vm', type: 'voicemail', position: at, data: { config: { did: '+16175550199' } } },
  ],
  edges: [
    { id: 'e_1', source: 'n_start', sourceHandle: 'next', target: 'n_hi' },
    { id: 'e_2', source: 'n_hi', sourceHandle: 'next', target: 'n_menu' },
    { id: 'e_3', source: 'n_menu', sourceHandle: 'd:2', target: 'n_vm' },
    { id: 'e_4', source: 'n_menu', sourceHandle: 'd:1', target: 'n_bill' },
  ],
};

const RESULT: AssistProposal = {
  kind: 'proposal',
  draft_graph: PROPOSAL_GRAPH,
  new_prompts: [
    { placeholder_id: -1, name: 'Welcome', text: 'Thanks for calling Acme Power.' },
    { placeholder_id: -2, name: 'Main menu', text: 'For billing, press 1. To leave a message, press 2.' },
  ],
  summary: 'Callers hear a greeting, then the main menu: 1 rings Billing line (617-555-0100).',
  assumptions: ['You didn’t give a voicemail box, so 2 goes to Front desk mailbox (617-555-0199).'],
  issues: [{ code: 'x', message: 'Pick a mailbox.', node_id: 'n_vm' }],
  warnings: [],
};

const FLOW: Flow = {
  id: 42,
  name: 'Main line',
  revision: 3,
  published_version: null,
  published_at: null,
  updated_at: '2026-10-25T12:00:00Z',
  numbers: [],
  draft_graph: DRAFT,
};

/** Ids, types, positions, labels, configs and edges — what an undo must bring back (configs normalised as the store holds them). */
function shape(input: IvrGraph) {
  const w = fromGraph(input);
  const g = toGraph(w.nodes, w.edges, null);
  return {
    nodes: g.nodes.map((n) => [n.id, n.type, n.position, n.data.label ?? null, n.data.config]),
    edges: g.edges.map((e) => [e.source, e.sourceHandle, e.target]),
  };
}

/* ─── Store: the preview never touches the draft ─── */
const store: FlowStore = createFlowStore(FLOW);
{
  const s0 = store.getState();
  const draftNodes = s0.nodes;
  const seq0 = s0.changeSeq;
  const epoch0 = s0.graphEpoch;

  s0.showProposal('job-1', PROPOSAL_GRAPH);
  let s = store.getState();
  check('preview: the draft nodes are the same objects', true, s.nodes === draftNodes);
  check('preview: nothing to save, nothing to undo', [seq0, seq0, 0], [s.changeSeq, s.savedSeq, s.history.past.length]);
  check('preview: the draft graph is unchanged', shape(DRAFT), shape(s.graph()));
  check('preview: the canvas re-frames', epoch0 + 1, s.graphEpoch);

  const work = fromGraph(PROPOSAL_GRAPH);
  const order = callingOrder(work.nodes, work.edges);
  check('reveal order = calling order (menu keys in keypad order)', ['n_start', 'n_hi', 'n_menu', 'n_bill', 'n_vm'], order);
  check('preview: blocks keep the calling order', order, s.proposal?.order);
  check('preview: one block on screen to begin with', 1, s.proposal?.revealed);
  const tidy = tidyLayout(work.nodes, work.edges);
  check(
    'preview: laid out with Tidy up',
    order.map((id) => tidy.get(id)),
    order.map((id) => s.proposal?.nodes.find((n) => n.id === id)?.position),
  );

  const seen: number[] = [];
  let more = true;
  while (more) {
    more = store.getState().revealNext();
    seen.push(store.getState().proposal?.revealed ?? -1);
  }
  check('revealed one block at a time', [2, 3, 4, 5], seen);
  check('nothing more to reveal', false, store.getState().revealNext());

  store.getState().showProposal('job-2', PROPOSAL_GRAPH, { instant: true });
  s = store.getState();
  check('reduced motion: every block at once', [order.length, order.length], [s.proposal?.revealed, s.proposal?.order.length]);
  check('still no edit', [seq0, 0], [s.changeSeq, s.history.past.length]);
}

/* ─── Store: Accept is ONE undoable edit that autosave writes ─── */
{
  const before = store.getState();
  let autosaveSaw = 0;
  // The exact condition useAutosave subscribes with.
  const unsubscribe = store.subscribe((n, p) => {
    if (n.changeSeq !== p.changeSeq && n.changeSeq > n.savedSeq) autosaveSaw += 1;
  });
  const graph = acceptedGraph(PROPOSAL_GRAPH, new Map([[-1, 901], [-2, 902]]));
  before.replaceDraft(graph);
  let s = store.getState();
  check('accept: one undo step', before.history.past.length + 1, s.history.past.length);
  check('accept: dirty — autosave writes it', true, s.changeSeq > s.savedSeq);
  check('accept: autosave is told once', 1, autosaveSaw);
  check('accept: call logic changed (the checks re-run)', before.contentSeq + 1, s.contentSeq);
  check('accept: the canvas re-frames on the new flow', before.graphEpoch + 1, s.graphEpoch);
  check('accept: the overlay is gone', null, s.proposal);
  check('accept: the draft is the proposal, with real ids and Tidy-up positions', shape(graph), shape(s.graph()));
  check('accept: no placeholder reached the draft', [[901], [902]], s.graph().nodes.slice(1, 3).map((n) => (n.data.config as { prompts: number[] }).prompts));

  s.undo();
  s = store.getState();
  check('undo after accept: the previous draft is back', shape(DRAFT), shape(s.graph()));
  check('undo after accept: dirty again, so autosave writes the old draft back', true, s.changeSeq > s.savedSeq);
  s.redo();
  check('redo: the accepted draft again', shape(graph), shape(store.getState().graph()));
  unsubscribe();

  // Contrast: load() takes what the server already holds — nothing to save, no undo.
  store.getState().load({ ...FLOW, revision: 9, draft_graph: graph });
  s = store.getState();
  check('load(): treated as saved', s.changeSeq, s.savedSeq);
  check('load(): not undoable', 0, s.history.past.length);
}

/* ─── Rendering ─── */

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

/* The guide */
{
  const html = renderToStaticMarkup(
    createElement(KeywordGuide, { onUseExample: () => undefined, numbers: [{ name: 'Billing line', kind: 'Call forwarding' }] }),
  );
  const buttons = [...html.matchAll(/<button[^>]*data-example="(\d)"[^>]*>([\s\S]*?)<\/button>/g)];
  check('three example buttons', ['1', '2', '3'], buttons.map((b) => b[1]));
  buttons.forEach((b, i) => {
    const inner = /class="ivr-asg-example-text">([\s\S]*?)<\/span>/.exec(b[2]);
    check(`example ${i + 1} renders word for word`, GUIDE_EXAMPLES[i], inner ? decode(inner[1]) : null);
  });
  check('examples are enabled by default', false, /<button[^>]*disabled[^>]*data-example/.test(html));
  const all = text(html);
  check('the title', true, all.includes('What can I say?'));
  for (const row of VOCABULARY) {
    check(`row “${row.get}”`, true, all.includes(row.get) && all.includes(row.builds));
    for (const p of row.phrases) if ('say' in p) check(`phrase “${p.say}”`, true, all.includes(`“${p.say}”`));
  }
  for (const l of GUIDE_LIMITS) check(`limit “${l}”`, true, all.includes(l));
  check('the customer’s own number names', true, all.includes('Billing line Call forwarding'));

  const closed = renderToStaticMarkup(createElement(KeywordGuide, { onUseExample: () => undefined, examplesDisabled: true }));
  check('examples disabled while the box is closed', 3, [...closed.matchAll(/<button[^>]*disabled=""/g)].length);
}

/* Contexts for the panel and the banner */
function fakeAssist(state: ConversationState, draft = ''): FlowAssistant {
  const noop = () => undefined;
  return {
    available: true,
    state,
    canCompose: state.proposal === null || state.refineOf !== null,
    draft,
    setDraft: noop,
    send: noop,
    refine: noop,
    cancelRefine: noop,
    accept: noop,
    discard: noop,
    reset: noop,
    voices: [{ id: 'en_US-amy', label: 'Amy (US English)', gender: 'female', license: 'MIT' }],
    voicesLoading: false,
    voicesFailed: false,
    voice: 'en_US-amy',
    setVoice: noop,
    composerRef: { current: null },
    focusToken: 0,
    requestFocus: noop,
  };
}

const WORKSPACE: IvrWorkspace = {
  scope: ivrStaffScope(11),
  viewer: 'preview',
  staff: true,
  canEdit: true,
  customerName: 'Acme Power',
  href: (p) => p,
};

const BUILDER: BuilderData = {
  prompts: [],
  destinations: { groups: [] },
  destinationsLoading: false,
  destinationsFailed: false,
  ownDids: [],
  readOnly: true,
};

/**
 * Server rendering reads a zustand store's INITIAL state (useSyncExternalStore's
 * server snapshot), so the rendered tree is handed a view whose "initial" state
 * is the current one.
 */
const storeNow: FlowStore = { ...store, getInitialState: () => store.getState() };

function wrap(assist: FlowAssistant, child: ReactNode): ReactNode {
  return createElement(
    IvrWorkspaceContext.Provider,
    { value: WORKSPACE },
    createElement(
      FlowStoreContext.Provider,
      { value: storeNow },
      createElement(BuilderDataContext.Provider, { value: BUILDER }, createElement(AssistProvider, { value: assist }, child)),
    ),
  );
}

/* The panel */
{
  let s = initialConversation();
  s = conversationReducer(s, { type: 'started', jobId: 'j1', conversationId: 'c1', text: 'Press 1 for billing', refining: false, at: 0 });
  s = conversationReducer(s, { type: 'done', jobId: 'j1', result: { kind: 'clarify', question: 'Which number rings for billing?' } });
  const html = renderToStaticMarkup(wrap(fakeAssist(s, 'The billing line'), createElement(AssistPanel, { onClose: () => undefined })));
  const all = text(html);
  check('panel: titled “Flow assistant”', true, all.includes('Flow assistant'));
  check('panel: the disclosure, word for word', true, all.includes(DISCLOSURE));
  check('panel: the disclosure sits above the message box', true, html.indexOf('ivr-asst-disclosure') < html.indexOf('<textarea'));
  check('panel: the customer’s message and the question', true, all.includes('Press 1 for billing') && all.includes('Which number rings for billing?'));
  check('panel: the voice picker', true, all.includes('Voice for new messages') && all.includes('Amy (US English) (female)'));
  check('panel: the box is open', false, /<textarea[^>]*disabled/.test(html));
  check('panel: Send', true, />\s*Send\s*<\/button>|Send<\/button>/.test(html));

  const waiting = conversationReducer(s, { type: 'started', jobId: 'j2', conversationId: 'c1', text: 'Billing line', refining: false, at: 0 });
  const proposed = conversationReducer(waiting, { type: 'done', jobId: 'j2', result: RESULT });
  const html2 = renderToStaticMarkup(wrap(fakeAssist(proposed), createElement(AssistPanel, { onClose: () => undefined })));
  check('panel: with a proposal waiting, the box is closed', true, /<textarea[^>]*disabled/.test(html2));
  check('panel: …and says why', true, text(html2).includes('Accept, refine or discard the proposal to continue.'));
  check('panel: the proposal’s summary is in the transcript', true, text(html2).includes(RESULT.summary) && text(html2).includes('On the canvas'));

  const refining = conversationReducer(proposed, { type: 'refine' });
  const html3 = renderToStaticMarkup(wrap(fakeAssist(refining), createElement(AssistPanel, { onClose: () => undefined })));
  check('panel: Refine opens the box with the change hint', [false, true], [/<textarea[^>]*disabled/.test(html3), text(html3).includes('Changing the proposal.')]);

  const html4 = renderToStaticMarkup(wrap(fakeAssist(waiting), createElement(AssistPanel, { onClose: () => undefined })));
  check('panel: a running job shows its status', true, text(html4).includes('Drafting your flow…'));
}

/* The proposal banner */
{
  store.getState().showProposal('j2', RESULT.draft_graph, { instant: true });
  let s = initialConversation();
  s = conversationReducer(s, { type: 'started', jobId: 'j2', conversationId: 'c1', text: 't', refining: false, at: 0 });
  s = conversationReducer(s, { type: 'done', jobId: 'j2', result: RESULT });
  const html = renderToStaticMarkup(
    wrap(
      fakeAssist(s),
      createElement(ProposalBanner, { variant: 'docked', changes: null, onRefine: () => undefined, onTestCall: () => undefined }),
    ),
  );
  const all = text(html);
  check('banner: summary and assumption', true, all.includes(RESULT.summary) && all.includes(RESULT.assumptions[0]));
  check('banner: each new message by name with Listen', 2, [...html.matchAll(/aria-label="Listen to “[^"]+”"/g)].length);
  check('banner: new message names', true, all.includes('Welcome') && all.includes('Main menu'));
  check('banner: what still needs fixing, on its block', true, all.includes('Voicemail: Pick a mailbox.'));
  for (const label of ['Accept', 'Refine', 'Discard', 'Try a test call']) check(`banner: “${label}”`, true, all.includes(label));
  store.getState().clearProposal();
}

console.log(`ivr assist ui: ${passed} checks passed`);
