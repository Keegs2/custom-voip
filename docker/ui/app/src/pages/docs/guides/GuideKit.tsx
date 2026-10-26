/**
 * GuideKit — the pieces every customer guide is built from (layout kit,
 * docker/ui/CLAUDE.md §20):
 *
 *   ┌ How to ─────────────── [Expand all] ┐ ┌ At a glance ─────────┐
 *   │ ▸ Change where a number rings  …    │ │ Where   Products › … │
 *   │ ▸ Set how long a call rings    …    │ ├ Questions & fixes ───┤
 *   │ ▸ …                                 │ │ ▸ Calls aren't …     │
 *   └─────────────────────────────────────┘ └──────────────────────┘   one row, one height
 *
 * The tasks panel leads the row; "Questions & fixes" follows its height
 * (`.lk-follow`) and scrolls inside when the questions don't fit.
 *
 * Each task is a Disclosure row: title + one-line summary closed, the steps
 * open. `#<task id>` in the URL opens that task and scrolls to it, so a task
 * can be linked to directly. Below the grid's stack width the right column
 * goes under the tasks.
 *
 * Inline helpers: <Steps> (numbered), <Ui> (an on-screen label, exactly as
 * the app spells it), <Path> (sidebar route, "Products › RCF"), <Note>.
 *
 * React #310: every hook sits at the top of its component, before any return.
 */
import { Children, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronsDownUp, ChevronsUpDown, Info } from 'lucide-react';
import { BalancedGrid, Disclosure, ScrollArea } from '../../../components/layout/kit';
import type { GuideFaq, GuideFact, GuideTask, ProductGuideContent } from './guideTopics';

/* ─── Inline helpers ─────────────────────────────────────────── */

/** An on-screen label — a button, tab, field or status word, spelled as the app spells it. */
export function Ui({ children }: { children: ReactNode }) {
  return <span className="gd-ui">{children}</span>;
}

/** A place in the sidebar: <Path items={['Products', 'RCF']} /> → Products › RCF. */
export function Path({ items }: { items: readonly string[] }) {
  return (
    <span className="gd-path">
      {items.map((item, i) => (
        <span key={item} className="gd-path-step">
          {i > 0 && (
            <span className="gd-path-sep" aria-hidden="true">
              ›
            </span>
          )}
          {item}
        </span>
      ))}
    </span>
  );
}

/** Numbered steps. Each child is one step. */
export function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="gd-steps">
      {Children.toArray(children).map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

/** A plain paragraph in guide copy. */
export function Para({ children }: { children: ReactNode }) {
  return <p className="gd-p">{children}</p>;
}

/** A short bulleted list. Each child is one item. */
export function Bullets({ children }: { children: ReactNode }) {
  return (
    <ul className="gd-bullets">
      {Children.toArray(children).map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** A tinted note under the steps (who can do it, what to expect). */
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="gd-note">
      <Info size={14} aria-hidden="true" className="gd-note-icon" />
      <div>{children}</div>
    </div>
  );
}

/** Term → explanation pairs (block names, status words). */
export function Terms({ items }: { items: readonly { term: string; text: ReactNode }[] }) {
  return (
    <dl className="gd-terms">
      {items.map((t) => (
        <div key={t.term} className="gd-term">
          <dt>{t.term}</dt>
          <dd>{t.text}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ─── A whole product guide ──────────────────────────────────── */

/** The "How to" tasks beside "At a glance" + "Questions & fixes", as one balanced row. */
export function ProductGuide({ content }: { content: ProductGuideContent }) {
  return (
    <BalancedGrid columns="minmax(0, 1.55fr) minmax(0, 1fr)" stackBelow="md" gap="var(--rcf-stack)" className="gd-grid">
      <TaskPanel topic={content.topic} intro={content.intro} tasks={content.tasks} />
      <div className="lk-col">
        <FactsCard topic={content.topic} facts={content.facts} />
        <FaqCard topic={content.topic} faq={content.faq} />
      </div>
    </BalancedGrid>
  );
}

/** Task id from the URL hash (`#change-destination`), or '' when none. */
function hashTaskId(hash: string): string {
  if (!hash.startsWith('#')) return '';
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return '';
  }
}

function TaskPanel({ topic, intro, tasks }: { topic: string; intro: string; tasks: readonly GuideTask[] }) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const { hash } = useLocation();
  const ids = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const linked = hashTaskId(hash);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(ids.includes(linked) ? [linked] : []));
  const [seenLink, setSeenLink] = useState(linked);

  // A new #task in the URL (a link on this page) opens that task too —
  // render-time "adjust state when an input changes".
  if (linked !== seenLink) {
    setSeenLink(linked);
    if (ids.includes(linked) && !open.has(linked)) setOpen(new Set(open).add(linked));
  }

  useEffect(() => {
    if (!linked || !ids.includes(linked)) return;
    const el = document.getElementById(`gd-task-${linked}-btn`);
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  }, [linked, ids]);

  // ── Derived (after all hooks) ──
  const allOpen = ids.length > 0 && ids.every((id) => open.has(id));
  const setOne = (id: string, next: boolean) => {
    setOpen((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  };
  const headId = `gd-howto-${topic}`;

  return (
    <section className="dl-panel gd-panel gd-tasks" aria-labelledby={headId}>
      <div className="dl-panel-head gd-panel-head">
        <h2 id={headId} className="dl-panel-title gd-panel-title">
          How to
        </h2>
        <span className="dl-count">{tasks.length}</span>
        <button
          type="button"
          className="gd-toggle-all"
          onClick={() => setOpen(allOpen ? new Set() : new Set(ids))}
          aria-pressed={allOpen}
        >
          {allOpen ? <ChevronsDownUp size={14} aria-hidden="true" /> : <ChevronsUpDown size={14} aria-hidden="true" />}
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
        <p className="dl-panel-sub">{intro}</p>
      </div>
      <div className="gd-rows">
        {tasks.map((task) => (
          <Disclosure
            key={task.id}
            id={`gd-task-${task.id}`}
            variant="row"
            headingLevel={3}
            className="gd-task"
            contentClassName="gd-task-body"
            icon={task.icon}
            title={task.title}
            summary={task.summary}
            open={open.has(task.id)}
            onOpenChange={(next) => setOne(task.id, next)}
          >
            {task.body}
          </Disclosure>
        ))}
      </div>
    </section>
  );
}

function FactsCard({ topic, facts }: { topic: string; facts: readonly GuideFact[] }) {
  const headId = `gd-glance-${topic}`;
  return (
    <section className="dl-panel gd-panel gd-facts-card" aria-labelledby={headId}>
      <div className="dl-panel-head gd-panel-head">
        <h2 id={headId} className="dl-panel-title gd-panel-title">
          At a glance
        </h2>
      </div>
      <dl className="gd-facts">
        {facts.map((f) => (
          <div key={f.label} className="gd-fact">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function FaqCard({ topic, faq }: { topic: string; faq: readonly GuideFaq[] }) {
  const headId = `gd-faq-${topic}`;
  return (
    <section className="dl-panel gd-panel gd-faq lk-follow" aria-labelledby={headId}>
      <div className="dl-panel-head gd-panel-head">
        <h2 id={headId} className="dl-panel-title gd-panel-title">
          Questions &amp; fixes
        </h2>
        <span className="dl-count">{faq.length}</span>
      </div>
      <ScrollArea className="gd-rows" label="Questions and fixes">
        {faq.map((item) => (
          <Disclosure
            key={item.id}
            id={`gd-faq-${item.id}`}
            variant="row"
            headingLevel={3}
            className="gd-q"
            contentClassName="gd-q-body"
            title={item.question}
          >
            {item.answer}
          </Disclosure>
        ))}
      </ScrollArea>
    </section>
  );
}
