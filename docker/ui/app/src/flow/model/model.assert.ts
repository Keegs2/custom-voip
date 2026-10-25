import { fromGraph, toGraph } from './graph.ts';
import { emptyHistory, record, redo, snapshotOf, undo, type Snapshot } from './history.ts';
import { outHandles } from './blocks.ts';
import { tidyLayout } from './layout.ts';
import { formatClockTime, formatWeekly } from './summary.ts';

// ═════════════════════════════════════════════════════════════════════════════
// model.assert.ts — self-test for the builder's pure model: the §2 graph
// round trip (unknown fields preserved), exits, undo history and layout.
//
//   node src/flow/model/model.assert.ts       (or: node scripts/run-ivr-tests.mjs)
// ═════════════════════════════════════════════════════════════════════════════

let passed = 0;

function check(what: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`[ivr model] ${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  passed += 1;
}

/* ─── Graph round trip preserves what this UI doesn't know ─── */
{
  const server = {
    schemaVersion: 1,
    futureFlag: { a: 1 },
    nodes: [
      { id: 'n_s', type: 'entry', position: { x: 0, y: 0 }, data: { config: {} }, zIndex: 3 },
      {
        id: 'n_p',
        type: 'play',
        position: { x: 300.6, y: 10.2 },
        data: { label: 'Hello', config: { prompts: [7], volume: 'loud' }, note: 'kept' },
      },
      { id: 'n_x', type: 'webhook', position: { x: 9, y: 9 }, data: { config: { url: 'kept' } } },
    ],
    edges: [
      { id: 'e_1', source: 'n_s', sourceHandle: 'next', target: 'n_p', animated: true },
      { id: 'e_dup', source: 'n_s', sourceHandle: 'next', target: 'n_p' },
      { id: 'e_bad', source: 'n_p', sourceHandle: 'next', target: 'n_s' },
    ],
    viewport: { x: 10, y: 20, zoom: 0.75 },
  };
  const w = fromGraph(server);
  check('Start is not deletable', false, w.nodes[0].deletable);
  check('second edge on one exit dropped; edge into Start dropped', ['e_1'], w.edges.map((e) => e.id));
  check('unknown node type kept aside', ['n_x'], w.foreignNodes.map((n) => n.id));
  const back = toGraph(w.nodes, w.edges, w.viewport, w);
  const play = back.nodes.find((n) => n.id === 'n_p') as unknown as Record<string, unknown>;
  check('unknown config key kept', 'loud', (play.data as { config: { volume: string } }).config.volume);
  check('unknown data key kept', 'kept', (play.data as { note: string }).note);
  check('positions are whole pixels', { x: 301, y: 10 }, play.position);
  check('unknown node key kept', 3, (back.nodes[0] as unknown as { zIndex: number }).zIndex);
  check('unknown edge key kept', true, (back.edges[0] as unknown as { animated: boolean }).animated);
  check('unknown graph key kept', { a: 1 }, (back as unknown as { futureFlag: unknown }).futureFlag);
  check('foreign block re-emitted last', 'n_x', back.nodes[back.nodes.length - 1].id);
  check('viewport kept', { x: 10, y: 20, zoom: 0.75 }, back.viewport);

  const noStart = fromGraph({ schemaVersion: 1, nodes: [], edges: [] });
  check('a graph without Start gets one', ['entry'], noStart.nodes.map((n) => n.type));

  const messy = fromGraph({ nodes: [{ id: 'n_m', type: 'menu', position: { x: 0, y: 0 }, data: { config: { digits: ['9', '1', 'x', '1'] } } }] });
  const menuCfg = messy.nodes.find((n) => n.id === 'n_m')?.data.config as { digits: string[]; timeoutSec: number };
  check('menu digits cleaned into keypad order', ['1', '9'], menuCfg.digits);
  check('missing fields defaulted', 5, menuCfg.timeoutSec);
}

/* ─── Exits follow the menu keys ─── */
{
  const menu = { type: 'menu' as const, data: { config: { digits: ['2', '1', '#'] } } };
  check('menu exits', ['d:1', 'd:2', 'd:#', 'noInput', 'noMatch'], outHandles(menu).map((h) => h.id));
  check('dial exit', ['noAnswer'], outHandles({ type: 'dial', data: { config: {} } }).map((h) => h.id));
  check('voicemail ends the path', [], outHandles({ type: 'voicemail', data: { config: {} } }));
}

/* ─── Undo history ─── */
{
  const n = (x: number, selected = false) => ({ id: 'n_a', type: 'play', position: { x, y: 0 }, data: { config: { prompts: [] } }, selected });
  const snap = (x: number, selected = false): Snapshot => snapshotOf([n(x, selected)], []);
  let h = emptyHistory();

  h = record(h, snap(0, false), snap(0, true), null, 1000);
  check('selecting a block records nothing', 0, h.past.length);

  // A drag: many position changes, one key — undo returns to where it STARTED.
  h = record(h, snap(0), snap(10), 'drag:n_a', 2000);
  h = record(h, snap(10), snap(20), 'drag:n_a', 2050);
  h = record(h, snap(20), snap(30), 'drag:n_a', 2100);
  check('a drag is one undo step', 1, h.past.length);
  check('…holding the position before the drag', 0, h.past[0].nodes[0].position.x);

  const u = undo(h, snap(30));
  check('undo restores the start of the drag', 0, u?.snapshot.nodes[0].position.x);
  const r = u ? redo(u.history, u.snapshot) : null;
  check('redo returns to the end of the drag', 30, r?.snapshot.nodes[0].position.x);

  // The same key after a pause is a new step.
  let h2 = record(emptyHistory(), snap(0), snap(5), 'cfg:n_a:x', 1000);
  h2 = record(h2, snap(5), snap(6), 'cfg:n_a:x', 5000);
  check('a pause splits typing into two steps', 2, h2.past.length);

  // A new edit drops redo.
  const u2 = undo(h2, snap(6));
  const h3 = u2 ? record(u2.history, u2.snapshot, snap(99), null, 9000) : emptyHistory();
  check('a new edit clears redo', 0, h3.future.length);
}

/* ─── Tidy layout ─── */
{
  const nodes = [
    { id: 's', type: 'entry' as const, data: { config: {} } },
    { id: 'm', type: 'menu' as const, data: { config: { digits: ['1', '2'] } } },
    { id: 'a', type: 'hangup' as const, data: { config: {} } },
    { id: 'b', type: 'hangup' as const, data: { config: {} } },
    { id: 'o', type: 'hangup' as const, data: { config: {} } },
  ];
  const edges = [
    { source: 's', sourceHandle: 'next', target: 'm' },
    { source: 'm', sourceHandle: 'd:1', target: 'a' },
    { source: 'm', sourceHandle: 'd:2', target: 'b' },
  ];
  const pos = tidyLayout(nodes, edges);
  check('columns by depth', [0, 320, 640, 640], ['s', 'm', 'a', 'b'].map((id) => pos.get(id)?.x));
  check('parent aligned with its first child', pos.get('a')?.y, pos.get('m')?.y);
  check('siblings stacked', true, (pos.get('b')?.y ?? 0) > (pos.get('a')?.y ?? 0));
  check('an unreachable block goes in its own column', true, (pos.get('o')?.x ?? 0) > 640);
}

/* ─── Wording ─── */
{
  check('clock times', ['9 AM', '5:30 PM', 'noon', 'midnight'], ['09:00', '17:30', '12:00', '24:00'].map(formatClockTime));
  check(
    'weekly grouping',
    'Mon–Fri 9 AM–5 PM · Sat 10 AM–2 PM',
    formatWeekly({
      mon: [['09:00', '17:00']],
      tue: [['09:00', '17:00']],
      wed: [['09:00', '17:00']],
      thu: [['09:00', '17:00']],
      fri: [['09:00', '17:00']],
      sat: [['10:00', '14:00']],
      sun: [],
    }),
  );
}

console.log(`ivr model: ${passed} checks passed`);
