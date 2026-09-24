/**
 * PDF summary document — the @react-pdf/renderer component tree.
 *
 * LAZY-LOADED: only reportPdf.ts imports this file, and ReportingPage reaches
 * reportPdf.ts only through a dynamic `import('./reportPdf')` when the user
 * clicks "Download PDF summary", so react-pdf (and its layout/font engine)
 * lands in its own chunk and never weighs down the main bundle.
 *
 * Content = what's already on screen, from the same query-cache data: the
 * header sentence, totals, call quality, busiest times, missed reasons, the
 * calls-over-time table and the numbers table. No call-level list (that's
 * what the spreadsheet is for). Same hard rules as the page: whole minutes
 * only, no rates, no routing internals.
 *
 * Uses the built-in Helvetica family (WinAnsi), so copy sticks to Latin-1 +
 * common punctuation (– ’ ·).
 */
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { ReportNumbers, ReportOverview, ReportTrend, TrendBucket } from '../../types/reports';
import {
  dayKeyToUtc,
  fmtAvgMinutes,
  fmtCount,
  fmtHourRange,
  fmtMinutes,
  fmtPct,
  fmtPhone,
  fmtWeekdayDate,
  GRADE_BLURB,
  GRADE_TONE,
  GRADE_WORD,
  honestWhole,
} from './reportFormat';

export interface ReportPdfInput {
  customerName: string | null;
  rangeLabel: string;
  tz: string;
  sentence: string;
  numbersNote: string | null;
  overview: ReportOverview;
  trend: ReportTrend | null;
  numbers: ReportNumbers | null;
}

const INK = '#0e1726';
const INK_SOFT = '#46566f';
const INK_DIM = '#5d6f8c';
const LINE = '#e2e8f2';
const TINT = '#f7f9fc';

const s = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 52, paddingHorizontal: 40, fontFamily: 'Helvetica', fontSize: 9.5, color: INK },
  brand: { fontSize: 8, color: INK_DIM, letterSpacing: 1, textTransform: 'uppercase' },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 20, marginTop: 6 },
  meta: { fontSize: 9, color: INK_SOFT, marginTop: 4 },
  rule: { height: 1, backgroundColor: LINE, marginVertical: 14 },
  sentence: { fontSize: 12.5, lineHeight: 1.45, color: INK },
  h2: { fontFamily: 'Helvetica-Bold', fontSize: 11.5, marginBottom: 8, color: INK },
  section: { marginTop: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1, borderColor: LINE, borderRadius: 6 },
  cell: { width: '25%', paddingVertical: 8, paddingHorizontal: 10, borderColor: LINE },
  cellValue: { fontFamily: 'Helvetica-Bold', fontSize: 13 },
  cellLabel: { fontSize: 7.5, color: INK_DIM, marginTop: 3, textTransform: 'uppercase', letterSpacing: 0.6 },
  twoCol: { flexDirection: 'row', gap: 14 },
  col: { flex: 1, backgroundColor: TINT, borderRadius: 6, padding: 10 },
  eyebrow: { fontSize: 7.5, color: INK_DIM, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 3 },
  big: { fontFamily: 'Helvetica-Bold', fontSize: 13 },
  caption: { fontSize: 9, color: INK_SOFT, marginTop: 3, lineHeight: 1.4 },
  table: { borderWidth: 1, borderColor: LINE, borderRadius: 6 },
  tr: { flexDirection: 'row', borderTopWidth: 1, borderColor: LINE },
  trHead: { flexDirection: 'row', backgroundColor: TINT },
  th: { fontFamily: 'Helvetica-Bold', fontSize: 7.5, color: INK_DIM, textTransform: 'uppercase', letterSpacing: 0.5, paddingVertical: 6, paddingHorizontal: 7 },
  td: { fontSize: 9, paddingVertical: 5, paddingHorizontal: 7 },
  num: { textAlign: 'right' },
  note: { fontSize: 8.5, color: INK_SOFT, lineHeight: 1.45 },
  footer: { position: 'absolute', bottom: 24, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between', fontSize: 7.5, color: INK_DIM },
});

function trendLabel(bucket: TrendBucket, key: string): string {
  const d = dayKeyToUtc(key);
  if (bucket === 'month') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return bucket === 'week' ? `Week of ${day}` : day;
}

interface Col {
  label: string;
  width: string;
  align?: 'right';
}

function Table({ cols, rows }: { cols: Col[]; rows: string[][] }) {
  return (
    <View style={s.table}>
      <View style={s.trHead} fixed>
        {cols.map((c) => (
          <Text key={c.label} style={[s.th, { width: c.width }, c.align === 'right' ? s.num : {}]}>{c.label}</Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={i} style={s.tr} wrap={false}>
          {r.map((cell, j) => (
            <Text key={j} style={[s.td, { width: cols[j].width }, cols[j].align === 'right' ? s.num : {}]}>{cell}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export function ReportDocument({ input }: { input: ReportPdfInput }) {
  const { overview, trend, numbers } = input;
  const t = overview.totals;
  const q = overview.quality;
  const created = new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const reasons = [...overview.missed_reasons].filter((r) => r.calls > 0).sort((a, b) => b.calls - a.calls);
  const numberRows = numbers?.numbers ?? [];
  const showForward = numberRows.some((r) => r.product === 'rcf');

  const cells: Array<[string, string]> = [
    [fmtCount(t.calls), 'Calls'],
    [fmtCount(t.inbound), 'Incoming'],
    [fmtCount(t.outbound), 'Outgoing'],
    [fmtPct(t.answer_rate_pct), 'Answered'],
    [fmtCount(t.answered), 'Answered calls'],
    [fmtCount(t.missed), 'Missed calls'],
    [fmtMinutes(t.minutes), 'Time on the phone'],
    [fmtAvgMinutes(t.avg_minutes), 'Typical call'],
  ];

  return (
    <Document title={`Call report – ${input.rangeLabel}`} author="Granite" subject="Call report">
      <Page size="LETTER" style={s.page}>
        <Text style={s.brand}>Granite · Call report</Text>
        <Text style={s.title}>{input.customerName ? `${input.customerName} – calls` : 'Your calls'}</Text>
        <Text style={s.meta}>
          {input.rangeLabel} · times in {input.tz.replace(/_/g, ' ')} · made {created}
        </Text>
        {input.numbersNote && <Text style={s.meta}>{input.numbersNote}</Text>}
        <View style={s.rule} />

        <Text style={s.sentence}>{input.sentence}</Text>

        {t.calls > 0 && (
          <View style={s.section}>
            <Text style={s.h2}>The totals</Text>
            <View style={s.grid}>
              {cells.map(([value, label], i) => (
                <View
                  key={label}
                  style={[s.cell, { borderLeftWidth: i % 4 === 0 ? 0 : 1, borderTopWidth: i < 4 ? 0 : 1 }]}
                >
                  <Text style={s.cellValue}>{value}</Text>
                  <Text style={s.cellLabel}>{label}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={s.section} wrap={false}>
          <View style={s.twoCol}>
            <View style={s.col}>
              <Text style={s.eyebrow}>Call quality</Text>
              <Text style={[s.big, { color: GRADE_TONE[q.grade] }]}>{GRADE_WORD[q.grade]}</Text>
              <Text style={s.caption}>{GRADE_BLURB[q.grade]}</Text>
              {q.avg_mos != null && <Text style={s.caption}>Sound score {q.avg_mos.toFixed(1)} out of 5 (1 = hard to understand, 5 = crystal clear).</Text>}
              {q.pct_good_or_better != null && <Text style={s.caption}>{honestWhole(q.pct_good_or_better)} of every 100 measured calls sounded good or better.</Text>}
            </View>
            <View style={s.col}>
              <Text style={s.eyebrow}>Busiest times</Text>
              {overview.busiest_day ? (
                <>
                  <Text style={s.big}>{fmtWeekdayDate(overview.busiest_day.date)}</Text>
                  <Text style={s.caption}>{fmtCount(overview.busiest_day.calls)} calls that day.</Text>
                </>
              ) : (
                <Text style={s.caption}>No calls yet.</Text>
              )}
              {overview.busiest_hour && (
                <>
                  <Text style={[s.big, { marginTop: 8 }]}>{fmtHourRange(overview.busiest_hour.hour)}</Text>
                  <Text style={s.caption}>{fmtCount(overview.busiest_hour.calls)} calls started in this hour across the period.</Text>
                </>
              )}
            </View>
          </View>
        </View>

        {t.missed > 0 && (
          <View style={s.section} wrap={false}>
            <Text style={s.h2}>Missed calls and why</Text>
            {reasons.length > 0 ? (
              <Table
                cols={[
                  { label: 'Reason', width: '64%' },
                  { label: 'Calls', width: '18%', align: 'right' },
                  { label: 'Share', width: '18%', align: 'right' },
                ]}
                rows={reasons.map((r) => [r.label, fmtCount(r.calls), fmtPct((r.calls / t.missed) * 100)])}
              />
            ) : (
              <Text style={s.note}>{fmtCount(t.missed)} missed calls — no reason on file.</Text>
            )}
          </View>
        )}

        {trend && trend.points.length > 0 && (
          <View style={s.section}>
            <Text style={s.h2}>Calls over time</Text>
            <Table
              cols={[
                { label: trend.bucket === 'month' ? 'Month' : trend.bucket === 'week' ? 'Week' : 'Day', width: '40%' },
                { label: 'Calls', width: '15%', align: 'right' },
                { label: 'Answered', width: '15%', align: 'right' },
                { label: 'Missed', width: '15%', align: 'right' },
                { label: 'Minutes', width: '15%', align: 'right' },
              ]}
              rows={trend.points.map((p) => [
                trendLabel(trend.bucket, p.date),
                fmtCount(p.calls),
                fmtCount(p.answered),
                fmtCount(p.missed),
                fmtCount(p.minutes),
              ])}
            />
          </View>
        )}

        {numberRows.length > 0 && (
          <View style={s.section}>
            <Text style={s.h2}>Your numbers</Text>
            <Table
              cols={
                showForward
                  ? [
                      { label: 'Number', width: '30%' },
                      { label: 'Currently forwards to', width: '20%' },
                      { label: 'Calls', width: '11%', align: 'right' },
                      { label: 'Answered', width: '13%', align: 'right' },
                      { label: 'Minutes', width: '13%', align: 'right' },
                      { label: 'Quality', width: '13%' },
                    ]
                  : [
                      { label: 'Number', width: '40%' },
                      { label: 'Calls', width: '14%', align: 'right' },
                      { label: 'Answered', width: '16%', align: 'right' },
                      { label: 'Minutes', width: '15%', align: 'right' },
                      { label: 'Quality', width: '15%' },
                    ]
              }
              rows={numberRows.map((r) => {
                const label = r.name ? `${fmtPhone(r.number)}  ${r.name}` : fmtPhone(r.number);
                const quality = r.grade === 'none' ? '–' : GRADE_WORD[r.grade];
                const answered = r.calls > 0 ? fmtPct(r.answer_rate_pct) : '–';
                const minutes = r.calls > 0 ? fmtCount(r.minutes) : '–';
                return showForward
                  ? [label, r.forwards_to ? fmtPhone(r.forwards_to) : '–', fmtCount(r.calls), answered, minutes, quality]
                  : [label, fmtCount(r.calls), answered, minutes, quality];
              })}
            />
          </View>
        )}

        <View style={s.section} wrap={false}>
          <Text style={s.h2}>What the words mean</Text>
          <Text style={s.note}>Answered – someone picked up. Missed – the call ended before anyone picked up.</Text>
          <Text style={s.note}>Minutes – how long answered calls lasted, rounded to whole minutes (totals are rounded once, at the end).</Text>
          <Text style={s.note}>Call quality – how clear calls sounded: Great, Good, Fair or Poor, from a 1-to-5 sound score.</Text>
        </View>

        <View style={s.footer} fixed>
          <Text>{input.rangeLabel}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
