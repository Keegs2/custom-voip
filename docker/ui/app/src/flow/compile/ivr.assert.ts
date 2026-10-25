import type { Destinations, IvrEdge, IvrGraph, IvrNode } from '../../types/ivr.ts';
import { compileIvr, describePlan, mergeRanges, toMinutes, type CompileContext } from './ivr.ts';

// ═════════════════════════════════════════════════════════════════════════════
// ivr.assert.ts — fixture tests for the browser compile mirror (compile/ivr.ts).
//
// Same pattern as pages/voicemail/audio/wav.assert.ts: no test runner, so
// running this module IS the suite; it throws on the first failure. Imports
// carry the .ts extension so Node's type stripping runs it directly:
//
//   node src/flow/compile/ivr.assert.ts        (or: node scripts/run-ivr-tests.mjs)
//
// Each block below pins one of the bugs the review found in the transplanted
// compiler. Never imported by the app, so it never ships.
// ═════════════════════════════════════════════════════════════════════════════

let passed = 0;

function check(what: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`[ivr compile] ${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  passed += 1;
}

function ok(what: string, cond: boolean): void {
  if (!cond) throw new Error(`[ivr compile] ${what}`);
  passed += 1;
}

/* ─── Fixture: main menu → sales (no answer → voicemail), after hours → voicemail, 9 repeats ─── */

const DESTS: Destinations = {
  groups: [
    {
      product: 'rcf',
      label: 'Call forwarding',
      numbers: [{ did: '+16174544219', name: 'Sales line', enabled: true, detail: 'Forwards to +1 617-555-0102' }],
    },
    {
      product: 'voicemail',
      label: 'Voicemail boxes',
      numbers: [
        { did: '+16175550134', name: 'Front desk', enabled: true, detail: 'Mailbox: Front desk' },
        { did: '+16175550188', name: 'After-hours', enabled: true, detail: 'Mailbox: After-hours' },
      ],
    },
    { product: 'ivr', label: 'Other IVRs', numbers: [{ did: '+16174544300', name: 'Main IVR', enabled: true, detail: 'IVR: Main line' }] },
  ],
};

const PROMPTS = new Map([
  [1, { id: 1, name: 'Welcome' }],
  [2, { id: 2, name: 'Main menu options' }],
  [3, { id: 3, name: 'Recording notice' }],
  [4, { id: 4, name: 'Goodbye' }],
]);

const CTX: CompileContext = { prompts: PROMPTS, destinations: DESTS, ownDids: ['+16174544300'] };

const node = (n: IvrNode): IvrNode => n;
const edge = (source: string, sourceHandle: string, target: string): IvrEdge => ({
  id: `e_${source}_${sourceHandle.replace(':', '')}`,
  source,
  sourceHandle,
  target,
});

function fixture(): IvrGraph {
  return {
    schemaVersion: 1,
    nodes: [
      node({ id: 'n_start', type: 'entry', position: { x: 0, y: 0 }, data: { config: {} } }),
      node({ id: 'n_hello', type: 'play', position: { x: 0, y: 0 }, data: { label: 'Welcome', config: { prompts: [1] } } }),
      node({
        id: 'n_hours',
        type: 'schedule',
        position: { x: 0, y: 0 },
        data: {
          config: {
            tz: 'America/New_York',
            weekly: {
              mon: [['09:00', '12:00'], ['11:00', '17:00']],
              tue: [['09:00', '17:00']],
              wed: [['09:00', '17:00']],
              thu: [['09:00', '17:00']],
              fri: [['09:00', '17:00']],
              sat: [],
              sun: [],
            },
            closedDates: ['2026-12-25'],
          },
        },
      }),
      node({
        id: 'n_menu',
        type: 'menu',
        position: { x: 0, y: 0 },
        // Prompt order 3 then 2 — the old compiler emitted it reversed.
        data: { label: 'Main menu', config: { prompts: [3, 2], digits: ['1', '2', '9'], timeoutSec: 5, retries: 2 } },
      }),
      node({
        id: 'n_sales',
        type: 'dial',
        position: { x: 0, y: 0 },
        data: { label: 'Sales', config: { target: { kind: 'own', did: '+16174544219' }, passCallerId: true, ringTimeoutSec: 25 } },
      }),
      node({ id: 'n_vm', type: 'voicemail', position: { x: 0, y: 0 }, data: { config: { did: '+16175550134' } } }),
      node({ id: 'n_afterhours', type: 'voicemail', position: { x: 0, y: 0 }, data: { config: { did: '+16175550188' } } }),
      node({
        id: 'n_support',
        type: 'dial',
        position: { x: 0, y: 0 },
        data: { config: { target: { kind: 'external', number: '(212) 555-0299' }, passCallerId: false, ringTimeoutSec: 30 } },
      }),
      node({ id: 'n_repeat', type: 'goto', position: { x: 0, y: 0 }, data: { label: 'Repeat', config: { targetNodeId: 'n_menu' } } }),
      node({ id: 'n_bye', type: 'hangup', position: { x: 0, y: 0 }, data: { config: { prompts: [4] } } }),
    ],
    edges: [
      edge('n_start', 'next', 'n_hello'),
      edge('n_hello', 'next', 'n_hours'),
      edge('n_hours', 'open', 'n_menu'),
      edge('n_hours', 'closed', 'n_afterhours'),
      edge('n_menu', 'd:1', 'n_sales'),
      edge('n_menu', 'd:2', 'n_support'),
      edge('n_menu', 'd:9', 'n_repeat'),
      edge('n_menu', 'noInput', 'n_repeat'),
      edge('n_menu', 'noMatch', 'n_bye'),
      edge('n_sales', 'noAnswer', 'n_vm'),
      edge('n_support', 'noAnswer', 'n_vm'),
    ],
  };
}

/* ─── The realistic flow compiles clean ─── */
{
  const r = compileIvr(fixture(), CTX);
  check('fixture: no errors', [], r.issues.filter((i) => i.severity === 'error'));
  check('fixture: no warnings', [], r.issues.filter((i) => i.severity === 'warning'));
  check('start points at the welcome message', 'n_hello', r.plan.start);
  check('entry is not a plan node', false, 'n_start' in r.plan.nodes);
}

/* ─── Bug 1: menu prompts keep their order ─── */
{
  const r = compileIvr(fixture(), CTX);
  const menu = r.plan.nodes.n_menu;
  check('menu prompts in config order (not reversed)', [3, 2], menu.t === 'menu' ? menu.prompts : null);
  check('plan prompt list = first reference order, deduped', [1, 3, 2, 4], r.plan.prompts);
}

/* ─── Bug 2: loops are Go to blocks, compiled away ─── */
{
  const r = compileIvr(fixture(), CTX);
  const menu = r.plan.nodes.n_menu;
  check('press 9 jumps straight back to the menu', 'n_menu', menu.t === 'menu' ? menu.digits['9'] : null);
  check('no input also repeats the menu', 'n_menu', menu.t === 'menu' ? menu.on_noinput : null);
  check('the Go to block is not a plan node', false, 'n_repeat' in r.plan.nodes);
  ok('the Go to block still counts as reachable', r.reachable.has('n_repeat'));

  // A chain of Go to blocks resolves to the final target.
  const g = fixture();
  g.nodes.push(node({ id: 'n_hop', type: 'goto', position: { x: 0, y: 0 }, data: { config: { targetNodeId: 'n_repeat' } } }));
  g.edges = g.edges.map((e) => (e.sourceHandle === 'noInput' ? { ...e, target: 'n_hop' } : e));
  const r2 = compileIvr(g, CTX);
  const m2 = r2.plan.nodes.n_menu;
  check('goto → goto → menu resolves to the menu', 'n_menu', m2.t === 'menu' ? m2.on_noinput : null);

  // Go to blocks pointing at each other in a circle are an error.
  const loop = fixture();
  loop.nodes.push(node({ id: 'n_ga', type: 'goto', position: { x: 0, y: 0 }, data: { config: { targetNodeId: 'n_gb' } } }));
  loop.nodes.push(node({ id: 'n_gb', type: 'goto', position: { x: 0, y: 0 }, data: { config: { targetNodeId: 'n_ga' } } }));
  loop.edges = loop.edges.map((e) => (e.sourceHandle === 'noMatch' ? { ...e, target: 'n_ga' } : e));
  const r3 = compileIvr(loop, CTX);
  ok('goto loop reported', r3.issues.some((i) => i.code === 'goto_loop'));
  const m3 = r3.plan.nodes.n_menu;
  check('a goto loop resolves to hang up (null)', null, m3.t === 'menu' ? m3.on_nomatch : 'x');
}

/* ─── Bug 3: a removed menu key never routes ─── */
{
  const g = fixture();
  const menu = g.nodes.find((n) => n.id === 'n_menu');
  if (menu?.type === 'menu') menu.data.config.digits = ['1', '9']; // key 2 removed, its edge left behind
  const r = compileIvr(g, CTX);
  const m = r.plan.nodes.n_menu;
  check('removed key 2 has no branch', ['1', '9'], m.t === 'menu' ? Object.keys(m.digits).sort() : null);
  ok('the leftover edge is reported, not followed', r.issues.some((i) => i.code === 'stale_exit' && i.handle === 'd:2'));
  ok('support block is now unreachable', r.issues.some((i) => i.code === 'unreachable' && i.nodeId === 'n_support'));
}

/* ─── An unconnected key is an error pinned to its exit ─── */
{
  const g = fixture();
  g.edges = g.edges.filter((e) => e.sourceHandle !== 'd:2');
  const r = compileIvr(g, CTX);
  const issue = r.issues.find((i) => i.code === 'menu_key_unconnected');
  check('pinned to the menu and its d:2 exit', { nodeId: 'n_menu', handle: 'd:2' }, { nodeId: issue?.nodeId, handle: issue?.handle });
  check('not publishable', false, r.ok);
}

/* ─── Bug 4: transfer targets are validated ─── */
{
  const withTarget = (target: { kind: 'own'; did: string } | { kind: 'external'; number: string }) => {
    const g = fixture();
    const sales = g.nodes.find((n) => n.id === 'n_sales');
    if (sales?.type === 'dial') sales.data.config.target = target;
    return compileIvr(g, CTX).issues.filter((i) => i.nodeId === 'n_sales' && i.severity === 'error').map((i) => i.code);
  };
  check('own number on the account', [], withTarget({ kind: 'own', did: '+16174544219' }));
  check('no target chosen', ['transfer_no_target'], withTarget({ kind: 'own', did: '' }));
  check('not the customer’s number', ['transfer_not_owned'], withTarget({ kind: 'own', did: '+19995550100' }));
  check('this IVR’s own number', ['transfer_self'], withTarget({ kind: 'own', did: '+16174544300' }));
  check('outside US number', [], withTarget({ kind: 'external', number: '+1 617 555 0234' }));
  check('premium 900', ['transfer_premium'], withTarget({ kind: 'external', number: '9005550100' }));
  check('Canada (416)', ['transfer_canada'], withTarget({ kind: 'external', number: '4165550100' }));
  check('Jamaica (876)', ['transfer_caribbean'], withTarget({ kind: 'external', number: '8765550100' }));
  check('international', ['transfer_international'], withTarget({ kind: 'external', number: '+44 20 7946 0958' }));
  check('N11', ['transfer_n11'], withTarget({ kind: 'external', number: '911' + '5550100' }));
  check('555-01xx', ['transfer_fictional'], withTarget({ kind: 'external', number: '617-555-0123' }));
  check('Puerto Rico allowed', [], withTarget({ kind: 'external', number: '7875550234' }));
  check('toll-free allowed', [], withTarget({ kind: 'external', number: '8005550234' }));

  const g = fixture();
  const support = compileIvr(g, CTX).plan.nodes.n_support;
  check(
    'outside number normalised to E.164, caller ID off',
    { dest: { kind: 'external', e164: '+12125550299' }, pass: false },
    support.t === 'transfer' ? { dest: support.dest, pass: support.pass_caller_id } : null,
  );
  const sales = compileIvr(g, CTX).plan.nodes.n_sales;
  check('own number carries its product', { kind: 'own', did: '+16174544219', product: 'rcf' }, sales.t === 'transfer' ? sales.dest : null);
}

/* ─── Business hours ─── */
{
  check('HH:MM to minutes', [540, 1020, 1440, null, null], [toMinutes('09:00'), toMinutes('17:00'), toMinutes('24:00'), toMinutes('25:00'), toMinutes('9:00')]);
  check('overlaps merge', [[540, 1020]], mergeRanges([[540, 720], [660, 1020]]));
  check('touching ranges merge', [[540, 1020]], mergeRanges([[720, 1020], [540, 720]]));
  const r = compileIvr(fixture(), CTX);
  const hours = r.plan.nodes.n_hours;
  check('monday ranges merged in the plan', [[540, 1020]], hours.t === 'hours' ? hours.weekly.mon : null);
  check('closed dates carried', ['2026-12-25'], hours.t === 'hours' ? hours.closed_dates : null);

  const g = fixture();
  const h = g.nodes.find((n) => n.id === 'n_hours');
  if (h?.type === 'schedule') {
    h.data.config.weekly.tue = [['17:00', '09:00']];
    h.data.config.closedDates = ['2026-02-30'];
  }
  const codes = compileIvr(g, CTX).issues.map((i) => i.code);
  ok('backwards range reported', codes.includes('hours_backwards'));
  ok('impossible date reported', codes.includes('hours_bad_date'));
}

/* ─── Start, prompts, voicemail ─── */
{
  const g = fixture();
  g.edges = g.edges.filter((e) => e.source !== 'n_start');
  ok('unconnected Start is an error', compileIvr(g, CTX).issues.some((i) => i.code === 'start_unconnected'));

  const deleted = compileIvr(fixture(), { ...CTX, prompts: new Map([[1, { id: 1, name: 'Welcome' }]]) });
  ok('a deleted prompt is an error', deleted.issues.some((i) => i.code === 'prompt_missing' && i.nodeId === 'n_menu'));

  const unloaded = compileIvr(fixture(), { ...CTX, prompts: null, destinations: null });
  check('nothing loaded yet: no ownership/prompt false alarms', true, unloaded.ok);

  const wrongBox = fixture();
  const vm = wrongBox.nodes.find((n) => n.id === 'n_vm');
  if (vm?.type === 'voicemail') vm.data.config.did = '+16174544219'; // an RCF number, not a mailbox
  ok('voicemail must be a mailbox', compileIvr(wrongBox, CTX).issues.some((i) => i.code === 'voicemail_not_owned'));
}

/* ─── What callers hear ─── */
{
  const g = fixture();
  const r = compileIvr(g, CTX);
  const t = describePlan(g, r.plan, { promptName: (id) => PROMPTS.get(id)?.name ?? null, destinations: DESTS });
  check('reads in call order', ['n_hello', 'n_hours', 'n_menu', 'n_afterhours', 'n_sales', 'n_support', 'n_bye', 'n_vm'], t.map((e) => e.nodeId));
  check('welcome says its prompt', 'Plays “Welcome”.', t[0].says);
  const menu = t.find((e) => e.nodeId === 'n_menu');
  check(
    'menu branches in keypad order',
    ['Press 1', 'Press 2', 'Press 9', 'No key pressed', 'Wrong key'],
    menu?.branches.map((b) => b.label),
  );
  check('press 9 goes back to the menu (described earlier)', { toTitle: 'Main menu', earlier: true }, {
    toTitle: menu?.branches[2].toTitle,
    earlier: menu?.branches[2].earlier,
  });
  ok('menu reads its prompts in order', menu?.says.startsWith('Plays “Recording notice” then “Main menu options”') === true);
  const sales = t.find((e) => e.nodeId === 'n_sales');
  ok('transfer names the number', sales?.says.includes('Sales line · +1 (617) 454-4219') === true);
}

console.log(`ivr compile mirror: ${passed} checks passed`);
