import type { AssistProposal, IvrGraph } from '../../types/ivr.ts';
import { callingOrder, tidyLayout } from '../model/layout.ts';
import {
  acceptedGraph,
  createMissingPrompts,
  JOB_ERROR_TEXT,
  jobErrorText,
  MissingMessageError,
  parseAssistJob,
  placeholderIds,
  PromptCreateError,
  promptsToCreate,
  proposalChanges,
  proposalPromptName,
  substitutePlaceholders,
  withTidyPositions,
} from './model.ts';
import { summarizeBlock } from '../model/summary.ts';
import {
  buildStartRequest,
  canCompose,
  composeBlockedReason,
  conversationReducer,
  initialConversation,
  readRetryAfter,
  startErrorText,
  type ConversationState,
} from './conversation.ts';
import { DISCLOSURE, GUIDE_EXAMPLES, GUIDE_LIMITS, VOCABULARY } from './guide.ts';

// ═════════════════════════════════════════════════════════════════════════════
// assist.assert.ts — self-test for the Flow assistant's pure logic
// (docs/IVR_ASSIST_INTERFACES.md §5–§7): placeholder substitution, the
// accept-retry mapping reuse, Tidy-up positions, the reveal (calling) order,
// job parsing + error texts, the conversation state machine and the guide's
// contract wording.
//
//   node src/flow/assist/assist.assert.ts      (or: node scripts/run-ivr-tests.mjs)
// ═════════════════════════════════════════════════════════════════════════════

let passed = 0;

function check(what: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`[ivr assist] ${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  passed += 1;
}

async function rejects(what: string, run: () => Promise<unknown>, test: (err: unknown) => boolean): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!test(err)) throw new Error(`[ivr assist] ${what}: wrong error ${String(err)}`);
    passed += 1;
    return;
  }
  throw new Error(`[ivr assist] ${what}: did not throw`);
}

const at = { x: 0, y: 0 };

/** Start → Play [NP1, P7] → Menu [NP2] (1 → Transfer, 2 → Voicemail, no key → Hang up [NP3]). */
function proposalGraph(): IvrGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'n_start', type: 'entry', position: at, data: { config: {} } },
      { id: 'n_hi', type: 'play', position: at, data: { label: 'Greeting', config: { prompts: [-1, 7] } } },
      {
        id: 'n_menu',
        type: 'menu',
        position: at,
        data: {
          label: 'Main menu',
          config: { prompts: [-2], digits: ['1', '2'], timeoutSec: 5, retries: 1, invalidPrompts: [-1], noInputPrompts: [7] },
        },
      },
      {
        id: 'n_bill',
        type: 'dial',
        position: at,
        data: { label: 'Billing', config: { target: { kind: 'own', did: '+16175550100' }, passCallerId: true, ringTimeoutSec: 25 } },
      },
      { id: 'n_vm', type: 'voicemail', position: at, data: { config: { did: '+16175550199' } } },
      { id: 'n_bye', type: 'hangup', position: at, data: { config: { prompts: [-3] } } },
    ],
    edges: [
      { id: 'e_1', source: 'n_start', sourceHandle: 'next', target: 'n_hi' },
      { id: 'e_2', source: 'n_hi', sourceHandle: 'next', target: 'n_menu' },
      { id: 'e_3', source: 'n_menu', sourceHandle: 'd:1', target: 'n_bill' },
      { id: 'e_4', source: 'n_menu', sourceHandle: 'd:2', target: 'n_vm' },
      { id: 'e_5', source: 'n_menu', sourceHandle: 'noInput', target: 'n_bye' },
    ],
  };
}

function proposal(): AssistProposal {
  return {
    kind: 'proposal',
    draft_graph: proposalGraph(),
    new_prompts: [
      { placeholder_id: -1, name: 'Welcome', text: 'Thanks for calling.' },
      { placeholder_id: -2, name: 'Main menu', text: 'For billing, press 1. To leave a message, press 2.' },
      { placeholder_id: -3, name: 'Goodbye', text: 'Goodbye.' },
      { placeholder_id: -4, name: 'Never used', text: 'Nobody hears this.' },
    ],
    summary: 'Callers hear a greeting, then the main menu.',
    assumptions: [],
    issues: [],
    warnings: [],
  };
}

const promptsIn = (g: IvrGraph) =>
  g.nodes.map((n) => {
    const c = n.data.config as unknown as Record<string, unknown>;
    return [n.id, c.prompts ?? null, c.invalidPrompts ?? null, c.noInputPrompts ?? null];
  });

/* ─── Placeholder substitution ─── */
{
  const g = proposalGraph();
  const before = JSON.stringify(g);
  check('placeholders in first-use order, each once', [-1, -2, -3], placeholderIds(g));
  const out = substitutePlaceholders(g, new Map([[-1, 101], [-2, 102], [-3, 103]]));
  check(
    'every prompt list swapped: play, menu (prompts, invalid, no input), hang up — real ids untouched',
    [
      ['n_start', null, null, null],
      ['n_hi', [101, 7], null, null],
      ['n_menu', [102], [101], [7]],
      ['n_bill', null, null, null],
      ['n_vm', null, null, null],
      ['n_bye', [103], null, null],
    ],
    promptsIn(out),
  );
  check('no negative id survives', [], placeholderIds(out));
  check('the input graph is not changed', before, JSON.stringify(g));
  let missing: unknown = null;
  try {
    substitutePlaceholders(g, new Map([[-1, 101], [-2, 102]]));
  } catch (err) {
    missing = err;
  }
  check('an unmapped placeholder refuses (never saved)', true, missing instanceof MissingMessageError);
  check('…naming the placeholder', -3, (missing as MissingMessageError).placeholderId);
}

/* ─── New messages show by name on the proposal's blocks ─── */
{
  const names = proposalPromptName(proposal().new_prompts, (id) => (id === 7 ? 'Holiday notice' : null));
  const ctx = { promptName: names, destinations: null, titleOf: () => null };
  const g = proposalGraph();
  check('a play block names its new message (and the existing one)', 'Plays “Welcome” then “Holiday notice”', summarizeBlock(g.nodes[1], ctx));
  check('a menu block names its new message', 'Plays “Main menu”, listens for keys 1, 2', summarizeBlock(g.nodes[2], ctx));
  check('a hang-up block names its new message', 'Plays “Goodbye”, then hangs up', summarizeBlock(g.nodes[5], ctx));
  check('an unknown placeholder still reads as a message', 'a new message', names(-9));
}

/* ─── Accept: create the new messages, reuse them on retry ─── */
await (async () => {
  const p = proposal();
  check('only messages the graph uses are created', [-1, -2, -3], promptsToCreate(p, new Map()).map((x) => x.placeholder_id));

  const mapping = new Map<number, number>();
  const calls: string[] = [];
  let nextId = 500;
  let failOn: string | null = 'Main menu';
  const create = async (np: { name: string }) => {
    calls.push(np.name);
    if (np.name === failOn) throw new Error('tts down');
    return nextId++;
  };

  await rejects(
    'the first failure stops the accept',
    () => createMissingPrompts(p, mapping, create),
    (err) => err instanceof PromptCreateError && err.prompt.name === 'Main menu' && (err.cause as Error).message === 'tts down',
  );
  check('…after creating the ones before it', ['Welcome', 'Main menu'], calls);
  check('…which stay in the mapping', [[-1, 500]], [...mapping]);
  check('…and nothing after it was tried', false, calls.includes('Goodbye'));
  check('a retry plans only what is missing', [-2, -3], promptsToCreate(p, mapping).map((x) => x.placeholder_id));

  failOn = null;
  calls.length = 0;
  await createMissingPrompts(p, mapping, create);
  check('the retry creates only the missing messages', ['Main menu', 'Goodbye'], calls);
  check('the mapping is complete, the first message reused', [[-1, 500], [-2, 501], [-3, 502]], [...mapping]);

  calls.length = 0;
  await createMissingPrompts(p, mapping, create);
  check('a third run creates nothing', [], calls);

  const g = acceptedGraph(p.draft_graph, mapping);
  check('accepted graph: real ids everywhere', [], placeholderIds(g));
  check('accepted graph: the reused id is the one first created', [500, 7], (g.nodes[1].data.config as { prompts: number[] }).prompts);
  check('accepted graph: no viewport (the canvas re-frames)', false, 'viewport' in g);
})();

/* ─── Tidy-up positions are applied ─── */
{
  const g = withTidyPositions(proposalGraph());
  const pos = Object.fromEntries(g.nodes.map((n) => [n.id, n.position]));
  check('Start at the origin', { x: 0, y: 0 }, pos.n_start);
  check('columns by depth', [0, 320, 640, 960, 960, 960], ['n_start', 'n_hi', 'n_menu', 'n_bill', 'n_vm', 'n_bye'].map((id) => pos[id].x));
  check('menu exits stacked in exit order', true, pos.n_bill.y < pos.n_vm.y && pos.n_vm.y < pos.n_bye.y);
  const expected = tidyLayout(
    g.nodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
    g.edges,
  );
  check('exactly the builder’s Tidy up', [...expected.values()], g.nodes.map((n) => n.position));
  const accepted = acceptedGraph(proposalGraph(), new Map([[-1, 1], [-2, 2], [-3, 3]]));
  check('Accept writes the same Tidy-up positions', g.nodes.map((n) => n.position), accepted.nodes.map((n) => n.position));
}

/* ─── Reveal order = calling order ─── */
{
  const nodes = [
    { id: 'o', type: 'hangup' as const, data: { config: {} } },
    { id: 'c', type: 'hangup' as const, data: { config: {} } },
    { id: 'b', type: 'play' as const, data: { config: { prompts: [] } } },
    { id: 'a', type: 'hangup' as const, data: { config: {} } },
    { id: 'm', type: 'menu' as const, data: { config: { digits: ['2', '1'] } } },
    { id: 's', type: 'entry' as const, data: { config: {} } },
  ];
  const edges = [
    { source: 's', sourceHandle: 'next', target: 'm' },
    { source: 'm', sourceHandle: 'd:2', target: 'b' },
    { source: 'm', sourceHandle: 'd:1', target: 'a' },
    { source: 'b', sourceHandle: 'next', target: 'c' },
  ];
  check(
    'Start first, then each exit in keypad order depth-first, unreachable blocks last',
    ['s', 'm', 'a', 'b', 'c', 'o'],
    callingOrder(nodes, edges),
  );
  check('the order is the layout’s own walk', [...tidyLayout(nodes, edges).keys()], callingOrder(nodes, edges));
}

/* ─── Job parsing and the §5.3 texts ─── */
{
  check('§5.3 unavailable', 'The flow assistant is unavailable right now. You can keep building by hand.', jobErrorText('assistant_unavailable'));
  check('§5.3 busy', 'The flow assistant is busy. Try again in a minute.', jobErrorText('assistant_busy'));
  check('§5.3 failed', 'The flow assistant couldn’t finish that request. Try rewording it, or build it by hand.', jobErrorText('assistant_failed'));
  check('an unknown code reads as failed', JOB_ERROR_TEXT.assistant_failed, jobErrorText('model_no_result'));
  check('no code reads as failed', JOB_ERROR_TEXT.assistant_failed, jobErrorText(null));

  const running = parseAssistJob({ job_id: 'j1', conversation_id: 'c1', status: 'running', elapsed_ms: 1500 });
  check('running job', 'running', running?.status);
  const done = parseAssistJob({
    job_id: 'j1',
    conversation_id: 'c1',
    status: 'done',
    elapsed_ms: 9000,
    result: {
      kind: 'proposal',
      draft_graph: proposalGraph(),
      new_prompts: [{ placeholder_id: -1, name: 'Welcome', text: 'Hi.' }, { placeholder_id: 3, name: 'bad id', text: 'x' }],
      summary: 'S',
      assumptions: ['A', 7],
      issues: [{ code: 'x', message: 'Fix me', node_id: 'n_bye' }, { nope: true }],
    },
  });
  check('done proposal parsed', 'proposal', done?.status === 'done' && done.result?.kind);
  const r = done?.result?.kind === 'proposal' ? done.result : null;
  check('a non-negative placeholder id is dropped', [-1], r?.new_prompts.map((p) => p.placeholder_id));
  check('assumptions keep strings only', ['A'], r?.assumptions);
  check('issues keep readable ones', ['Fix me'], r?.issues.map((i) => i.message));
  check('missing warnings default to []', [], r?.warnings);
  const clarify = parseAssistJob({ job_id: 'j2', status: 'done', result: { kind: 'clarify', question: 'Which number?' } });
  check('clarify parsed', { kind: 'clarify', question: 'Which number?' }, clarify?.result);
  const junk = parseAssistJob({ job_id: 'j3', status: 'done', result: { kind: 'poem' } });
  check('an unreadable result becomes failed / assistant_failed', ['failed', 'assistant_failed'], [junk?.status, junk?.error?.code]);
  const failed = parseAssistJob({ job_id: 'j4', status: 'failed', error: { code: 'assistant_busy', message: 'from the server' } });
  check('failed job keeps its code', 'assistant_busy', failed?.error?.code);
  check('not a job', null, parseAssistJob({ status: 'running' }));
}

/* ─── The conversation ─── */
{
  const draft = proposalGraph();
  let s: ConversationState = initialConversation();
  check('a fresh panel can compose', true, canCompose(s));

  const first = buildStartRequest('  Press 1 for billing  ', s, draft);
  check('first message: trimmed, no conversation yet, the draft as base', ['Press 1 for billing', false, false, true], [
    first.message,
    'conversation_id' in first,
    'refine_job_id' in first,
    first.draft_graph === draft,
  ]);

  s = conversationReducer(s, { type: 'send' });
  check('sending closes the box', false, canCompose(s));
  s = conversationReducer(s, { type: 'started', jobId: 'job-1', conversationId: 'conv-1', text: 'Press 1 for billing', refining: false, at: 1000 });
  check('the customer turn is in the transcript', ['customer'], s.turns.map((t) => t.who));
  check('the conversation id is kept', 'conv-1', s.conversationId);
  check('running', 'job-1', s.running?.jobId);

  s = conversationReducer(s, { type: 'done', jobId: 'job-1', result: { kind: 'clarify', question: 'Which number rings for billing?' } });
  check('a question joins the transcript', ['customer', 'assistant'], s.turns.map((t) => t.who));
  const second = buildStartRequest('The billing line', s, draft);
  check('continuity: the next message carries the conversation id', 'conv-1', second.conversation_id);

  s = conversationReducer(s, { type: 'started', jobId: 'job-2', conversationId: 'conv-1', text: 'The billing line', refining: false, at: 2000 });
  s = conversationReducer(s, { type: 'done', jobId: 'job-other', result: proposal() });
  check('a result for another job is ignored', 'job-2', s.running?.jobId);
  s = conversationReducer(s, { type: 'done', jobId: 'job-2', result: proposal() });
  check('the proposal is on screen', 'job-2', s.proposal?.jobId);
  check('…and the box waits for a choice', [false, 'Accept, refine or discard the proposal to continue.'], [canCompose(s), composeBlockedReason(s)]);

  s = conversationReducer(s, { type: 'refine' });
  check('Refine opens the box for that proposal', [true, 'job-2'], [canCompose(s), s.refineOf]);
  const refine = buildStartRequest('Make 2 go to voicemail', s, draft);
  check('a refinement sends refine_job_id, same conversation, no draft', ['job-2', 'conv-1', false], [
    refine.refine_job_id,
    refine.conversation_id,
    'draft_graph' in refine,
  ]);

  s = conversationReducer(s, { type: 'started', jobId: 'job-3', conversationId: 'conv-1', text: 'Make 2 go to voicemail', refining: true, at: 3000 });
  s = conversationReducer(s, { type: 'done', jobId: 'job-3', result: { kind: 'cannot_build', message: 'I can only build call flows.' } });
  check('a refusal keeps the proposal and Refine mode', ['job-2', 'job-2'], [s.proposal?.jobId, s.refineOf]);

  s = conversationReducer(s, { type: 'started', jobId: 'job-4', conversationId: 'conv-1', text: 'Make 2 go to voicemail', refining: true, at: 4000 });
  s = conversationReducer(s, { type: 'done', jobId: 'job-4', result: proposal() });
  const states = s.turns.flatMap((t) => (t.who === 'assistant' && t.kind === 'proposal' ? [`${t.jobId}:${t.state}`] : []));
  check('a newer proposal replaces the one on screen', ['job-2:replaced', 'job-4:shown'], states);
  check('…and ends Refine mode', null, s.refineOf);

  s = conversationReducer(s, { type: 'acceptStart' });
  s = conversationReducer(s, { type: 'acceptFailed', text: 'nope' });
  check('a failed accept keeps the proposal and shows why', ['job-4', 'nope', false], [s.proposal?.jobId, s.acceptError, s.accepting]);
  s = conversationReducer(s, { type: 'accepted' });
  const last = s.turns[s.turns.length - 1];
  check('accepted', [null, 'accepted', true], [s.proposal, last.who === 'assistant' && last.kind === 'proposal' ? last.state : null, canCompose(s)]);

  let d = conversationReducer(
    conversationReducer(
      conversationReducer(initialConversation(), { type: 'started', jobId: 'j', conversationId: 'c', text: 't', refining: false, at: 0 }),
      { type: 'done', jobId: 'j', result: proposal() },
    ),
    { type: 'discarded' },
  );
  check('discarded', [null, true], [d.proposal, canCompose(d)]);
  d = conversationReducer(d, { type: 'failed', jobId: 'j', text: 'late' });
  check('a failure for a job no longer running is ignored', 2, d.turns.length);

  const blocked = conversationReducer(initialConversation(), { type: 'startFailed', text: 'not for you', blocked: true });
  check('403: the box stays closed', [false, 'not for you'], [canCompose(blocked), composeBlockedReason(blocked)]);
  check('a reset keeps it closed', false, canCompose(conversationReducer(blocked, { type: 'reset' })));
  const seq = conversationReducer(conversationReducer(initialConversation(), { type: 'startFailed', text: 'x' }), { type: 'startFailed', text: 'x' });
  check('the same words twice are announced twice', 2, seq.announceSeq);
}

/* ─── Start errors ─── */
{
  check('retry_after_s at the top', 12, readRetryAfter({ detail: 'assist_rate_limited', retry_after_s: 12 }));
  check('retry_after_s inside detail', 5, readRetryAfter({ detail: { code: 'assist_rate_limited', retry_after_s: 4.2 } }));
  check('no retry_after_s', null, readRetryAfter({ detail: 'assist_busy' }));
  check(
    'rate limited, with the wait',
    'That’s a lot of requests in a row. Try again in 12 seconds.',
    startErrorText({ status: 429, code: 'assist_rate_limited', retryAfterS: 12 }).text,
  );
  check('daily limit is not a block', false, startErrorText({ status: 429, code: 'assist_daily_limit', retryAfterS: null }).blocked);
  check('not enabled blocks', true, startErrorText({ status: 403, code: 'ivr_assist_not_enabled', retryAfterS: null }).blocked);
  check('a network failure reads as unavailable', JOB_ERROR_TEXT.assistant_unavailable, startErrorText({ status: null, code: null, retryAfterS: null }).text);
}

/* ─── What changed vs the draft ─── */
{
  const draft: IvrGraph = {
    schemaVersion: 1,
    nodes: [
      { id: 'n_start', type: 'entry', position: at, data: { config: {} } },
      { id: 'n_hi', type: 'play', position: { x: 300, y: 0 }, data: { label: 'Greeting', config: { prompts: [7] } } },
      { id: 'n_old', type: 'hangup', position: at, data: { config: {} } },
    ],
    edges: [
      { id: 'e_a', source: 'n_start', sourceHandle: 'next', target: 'n_hi' },
      { id: 'e_b', source: 'n_hi', sourceHandle: 'next', target: 'n_old' },
    ],
  };
  const c = proposalChanges(draft, proposalGraph());
  check('new blocks and changed ones (Start never marked)', [['n_hi', 'changed'], ['n_menu', 'new'], ['n_bill', 'new'], ['n_vm', 'new'], ['n_bye', 'new']], [...c.marks]);
  check('counts', [4, 1, 1], [c.added, c.changed, c.removed]);
  const same = proposalChanges(draft, { ...draft, nodes: draft.nodes.map((n) => ({ ...n, position: { x: 9, y: 9 } })) });
  check('moving blocks is not a change', [0, 0, 0], [same.added, same.changed, same.removed]);
}

/* ─── The guide is the contract's wording ─── */
{
  check('twelve vocabulary rows', 12, VOCABULARY.length);
  check('three examples', 3, GUIDE_EXAMPLES.length);
  check('four limits', 4, GUIDE_LIMITS.length);
  // node:fs without @types/node (the app's tsconfig is browser-only).
  type Fs = { existsSync(p: URL): boolean; readFileSync(p: URL, enc: 'utf8'): string };
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.('node:fs') as Fs | undefined;
  const contractPath = new URL('../../../../../../docs/IVR_ASSIST_INTERFACES.md', import.meta.url);
  if (fs?.existsSync(contractPath)) {
    const contract = fs.readFileSync(contractPath, 'utf8');
    const flat = contract.replace(/\s+/g, ' ');
    GUIDE_EXAMPLES.forEach((ex, i) => check(`example ${i + 1} is verbatim`, true, contract.includes(`"${ex}"`)));
    check('the disclosure is verbatim', true, flat.includes(`"${DISCLOSURE}"`));
    for (const row of VOCABULARY) {
      const line = contract.split('\n').find((l: string) => l.startsWith(`| ${row.get} |`));
      check(`row “${row.get}” is in the table`, true, line !== undefined);
      for (const p of row.phrases) if ('say' in p) check(`“${p.say}” is in its row`, true, line?.includes(`"${p.say}"`) ?? false);
    }
  } else {
    console.log('ivr assist: contract not found next to this checkout — wording check skipped');
  }
}

console.log(`ivr assist: ${passed} checks passed`);
