/**
 * ApiReference — the /docs/api page body for one section (§20 layout):
 *
 *   ┌ CompactHeader: Docs / API Reference · title · subtitle      Endpoints | Token | Format ┐
 *   ├ section rail (links): Getting started · Numbers & forwarding · Calls & reports · …    ┤
 *   └ MasterDetail ── Contents (groups → entries) │ Section: topics + endpoint rows ─────────┘
 *
 * The contents list and the reference are two equal-height panes bounded to
 * the first screen; the reference scrolls inside its pane. Picking an entry
 * opens it, scrolls it to the top and moves focus to its toggle; the URL
 * hash (#entry-id) deep-links it. Endpoint rows are collapsed by default and
 * their examples are collapsed inside them. Below 720px of content the
 * panes stack (contents first, capped) and the page scrolls as usual.
 *
 * Static content only — no API calls, so every persona (tenant, readonly,
 * admin, admin "View as Customer") sees the same customer-facing page.
 * The view is keyed by section in ApiDocsPage, so a switch starts fresh.
 * React #310: every hook is at the top of the component, before any return.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { CompactHeader, MasterDetail, ScrollArea, type HeaderStat } from '../../../components/layout/kit';
import { API_SECTIONS, apiSectionHref, type ApiSection } from '../docProducts';
import { BASE_URL } from './common';
import { EndpointCard, MethodChip } from './EndpointCard';
import { API_SECTION_DOCS, sectionEndpoints } from './sections';
import { RichText } from './RichText';
import { TopicSection } from './TopicSection';
import type { EntryDoc, GroupDoc } from './types';

import './apiReference.css';

/** Documented endpoints across every section (header stat). */
const TOTAL_ENDPOINTS = API_SECTIONS.reduce((n, s) => n + sectionEndpoints(API_SECTION_DOCS[s]).length, 0);

const HEADER_STATS: readonly HeaderStat[] = [
  { label: 'Endpoints', value: TOTAL_ENDPOINTS, title: 'Documented endpoints across every section' },
  { label: 'Token life', value: '8 h', title: 'A sign-in token is valid for 8 hours' },
  { label: 'Format', value: 'JSON' },
];

/** A pending "bring this entry into view" (seq makes a repeat click count). */
interface ScrollRequest {
  id: string;
  focus: boolean;
  seq: number;
}

const anchor = (id: string) => `api-${id}`;

/** The element to scroll to and the one to focus, for an entry id. */
function entryElements(id: string): { box: HTMLElement | null; focus: HTMLElement | null } {
  const toggle = document.getElementById(`${anchor(id)}-btn`);
  if (toggle) return { box: toggle.closest<HTMLElement>('.lk-disc'), focus: toggle };
  const heading = document.getElementById(`${anchor(id)}-h`);
  return { box: heading?.closest<HTMLElement>('.dxa-topic') ?? null, focus: heading };
}

/** Plain left click only — let the browser handle new-tab / copy-link gestures. */
function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function ApiReference({ section }: { section: ApiSection }) {
  // ALL hooks unconditionally at the top (React #310).
  const doc = API_SECTION_DOCS[section];
  const { hash } = useLocation();
  const navigate = useNavigate();

  const entryIds = useMemo(() => new Set(doc.groups.flatMap((g) => g.entries.map((e) => e.id))), [doc]);
  const endpointIds = useMemo(() => sectionEndpoints(doc).map((e) => e.id), [doc]);

  // A deep link (#entry-id) opens that entry on arrival.
  const [scroll, setScroll] = useState<ScrollRequest | null>(() => {
    const id = hash.slice(1);
    return entryIds.has(id) ? { id, focus: false, seq: 0 } : null;
  });
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set(scroll ? [scroll.id] : []));
  const railRef = useRef<HTMLElement>(null);

  // DOM only: where the section rail scrolls sideways (narrow screens), bring
  // the current section's tab into view. Horizontal only — never moves the page.
  useEffect(() => {
    const rail = railRef.current;
    const tab = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rail || !tab || rail.scrollWidth <= rail.clientWidth) return;
    const railBox = rail.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    rail.scrollLeft += tabBox.left - railBox.left - (railBox.width - tabBox.width) / 2;
  }, []);

  // DOM only: bring the requested entry to the top of its pane (or the page,
  // when the panes are stacked) and, for a contents click, focus it.
  useEffect(() => {
    if (!scroll) return;
    const { box, focus } = entryElements(scroll.id);
    box?.scrollIntoView({ block: 'start' });
    if (scroll.focus) focus?.focus({ preventScroll: true });
  }, [scroll]);

  const reveal = useCallback(
    (id: string) => {
      setOpenIds((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
      setScroll((prev) => ({ id, focus: true, seq: (prev?.seq ?? 0) + 1 }));
      navigate({ hash: id }, { replace: true });
    },
    [navigate],
  );

  const setEntryOpen = useCallback((id: string, open: boolean) => {
    setOpenIds((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const allOpen = endpointIds.length > 0 && endpointIds.every((id) => openIds.has(id));
  const toggleAll = () => setOpenIds(allOpen ? new Set() : new Set(endpointIds));
  const current = scroll?.id ?? null;

  const renderEntry = (e: EntryDoc) =>
    e.kind === 'endpoint' ? (
      <EndpointCard key={e.id} ep={e} open={openIds.has(e.id)} onOpenChange={(o) => setEntryOpen(e.id, o)} />
    ) : (
      <TopicSection key={e.id} topic={e} />
    );

  const renderGroup = (g: GroupDoc) => {
    const endpointsOnly = g.entries.every((e) => e.kind === 'endpoint');
    return (
      <section key={g.id} className="dxa-group" aria-labelledby={`api-g-${g.id}`}>
        <div className="dxa-group-head">
          <h3 className="dxa-group-title" id={`api-g-${g.id}`}>
            {g.title}
          </h3>
          {g.intro && (
            <p className="dxa-group-intro">
              <RichText text={g.intro} />
            </p>
          )}
        </div>
        {endpointsOnly ? <div className="dxa-eplist">{g.entries.map(renderEntry)}</div> : g.entries.map(renderEntry)}
      </section>
    );
  };

  const contents = (
    <>
      <div className="dxa-nav-head">
        <span className="dxa-nav-title">Contents</span>
        {endpointIds.length > 0 && (
          <span className="dxa-nav-count">
            {endpointIds.length} endpoint{endpointIds.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <ScrollArea className="dxa-nav-scroll" label={`${doc.label} contents`}>
        {doc.groups.map((g) => (
          <div key={g.id} className="dxa-nav-group">
            <p className="dxa-nav-group-title" id={`api-ng-${g.id}`}>
              {g.title}
            </p>
            <ul className="dxa-nav-list" aria-labelledby={`api-ng-${g.id}`}>
              {g.entries.map((e) => {
                const isCurrent = current === e.id;
                return (
                  <li key={e.id}>
                    <a
                      href={`${apiSectionHref(section)}#${e.id}`}
                      className={`dxa-nav-item${isCurrent ? ' is-current' : ''}`}
                      aria-current={isCurrent ? 'location' : undefined}
                      onClick={(ev) => {
                        if (!isPlainClick(ev)) return;
                        ev.preventDefault();
                        reveal(e.id);
                      }}
                    >
                      {e.kind === 'endpoint' ? (
                        <MethodChip method={e.method} compact />
                      ) : (
                        <span className="dxa-nav-topic" aria-hidden="true" />
                      )}
                      <span className="dxa-nav-label">{e.title}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </ScrollArea>
    </>
  );

  const reference = (
    <>
      <div className="dxa-pane-head">
        <div className="dxa-pane-id">
          <h2 className="dxa-pane-title">
            {doc.label}
            {doc.tag && <span className="dlx-tag-warn">{doc.tag}</span>}
          </h2>
          <p className="dxa-pane-intro">
            <RichText text={doc.intro} />
          </p>
        </div>
        {endpointIds.length > 0 && (
          <button type="button" className="dxa-allbtn" onClick={toggleAll}>
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>
      <ScrollArea className="dxa-doc-scroll">
        {section !== 'start' && (
          <p className="dxa-authline">
            Paths are relative to <code className="dlx-ic">{BASE_URL}</code>. Every request sends{' '}
            <code className="dlx-ic">Authorization: Bearer &lt;token&gt;</code> —{' '}
            <Link to="/docs/api#authentication">how to get a token</Link>.
          </p>
        )}
        {doc.groups.map(renderGroup)}
      </ScrollArea>
    </>
  );

  return (
    <div className="dl-scope dlx-docs dxa-scope">
      <div className="dl-shell dxa-shell">
        <CompactHeader
          className="fx-load"
          crumb={
            <>
              <span>Docs</span>
              <span className="dl-crumb-sep" aria-hidden="true">
                /
              </span>
              <span className="dxa-crumb-tail">API Reference</span>
            </>
          }
          title="API Reference"
          subtitle="Read and manage your account from your own systems — the same numbers, calls, reports and voicemail you see in the portal."
          stats={HEADER_STATS}
          statsLabel="API at a glance"
        />

        <nav ref={railRef} className="dl-tabs dl-tabs-scroll dxa-tabs fx-load fx-load-d1" aria-label="API sections">
          {API_SECTIONS.map((s) => {
            const d = API_SECTION_DOCS[s];
            const active = s === section;
            return (
              <Link
                key={s}
                to={apiSectionHref(s)}
                className={`dl-tab${active ? ' dl-tab-active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {d.label}
                {d.tag && <span className="dlx-tag-warn dxa-tab-tag">{d.tag}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="dxa-body fx-load fx-load-d2">
          <MasterDetail
            className="dxa-md"
            listLabel="Contents"
            detailLabel={doc.label}
            listWidth="minmax(232px, 268px)"
            listClassName="dl-panel dxa-navpane"
            detailClassName="dl-panel dxa-docpane"
            list={contents}
            detail={reference}
          />
        </div>
      </div>
    </div>
  );
}
