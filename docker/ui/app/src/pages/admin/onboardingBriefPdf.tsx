/**
 * onboardingBriefPdf.tsx — the downloadable SE Onboarding Intake Brief.
 *
 * A @react-pdf/renderer <Document> that renders the SAME brief model as the
 * on-screen preview (OnboardingBriefPage): every string / fact / verdict /
 * checklist item comes from briefContent.ts, so the two artifacts cannot
 * drift. `downloadBriefPdf(request)` generates the PDF client-side and
 * triggers a real browser download (crag-intake-brief-{id}.pdf) — genuine
 * vector PDF with selectable text, not a rasterized print capture.
 *
 * Typography: PDF core fonts only (Helvetica family + Courier for mono) —
 * zero network fetches, so generation works offline and never blocks on
 * webfont delivery. Weight/size hierarchy mirrors the Archivo/Public Sans
 * print stylesheet; colors are the same daylight-print palette
 * (ink-navy on white, azure accents, red flag, amber high-volume).
 *
 * Letter size, 1-2 pages. `wrap={false}` on every section/block mirrors the
 * stylesheet's `break-inside: avoid` so nothing splits across a page break.
 *
 * IMPORTANT: import this module only via dynamic `import()` —
 * @react-pdf/renderer is heavy and must stay out of the main bundle.
 */
/* eslint-disable react-refresh/only-export-components --
   Generation-only module: the react-pdf components here never mount in the
   browser DOM, and the module is loaded via dynamic import() on demand, so
   it is never part of the Vite HMR component graph. */
import {
  Document,
  Font,
  Page,
  Path,
  Svg,
  Text,
  View,
  pdf,
  StyleSheet,
} from '@react-pdf/renderer';
import type { Style } from '@react-pdf/stylesheet';
import type { OnboardingRequest } from '../../types/onboarding';
import { fmt } from '../../utils/format';
import {
  BRIEF_BRAND,
  BRIEF_TITLE,
  FOOTER_LEFT,
  HV_BANNER_TITLE,
  RED_FLAG_TEXT,
  STATUS_LABELS,
  type BriefFact,
  type ProductBlock,
  briefFileName,
  buildActionChecklist,
  buildCapacityModel,
  buildHvFacts,
  buildKycFacts,
  buildProductsModel,
  fmtBriefDate,
  footerRight,
  hvBannerSub,
} from './briefContent';

// ─── Palette — the onboarding-brief.css print palette, tints pre-composited
//     on paper white (react-pdf renders solid fills more reliably than alpha).
const C = {
  ink: '#0e1726',
  soft: '#3d4c63',
  dim: '#5d6f8c',
  faint: '#8b99ad',
  azure: '#1d63dd',
  line: '#d7dfea',
  lineSoft: '#e9eef5',
  tint: '#f4f7fb',
  green: '#15803d',
  red: '#b91c1c',
  amber: '#92400e',
  amberDeep: '#b45309',
  amberLine: '#c8956a',
  amberInk: '#7c3f10',
  azureTint: '#f1f6fd',
  greenTint: '#f1f7f3',
  redTint: '#fcf4f4',
  hvBannerBg: '#f8f0e9',
  hvRecBg: '#fbf6f3',
} as const;

// PDF core fonts — no registration, no network.
const SANS = 'Helvetica';
const SANS_BOLD = 'Helvetica-Bold';
const MONO = 'Courier';
const MONO_BOLD = 'Courier-Bold';

// No mid-word hyphenation ("answer-ing") — words wrap whole. Overlong
// unbreakable tokens (emails, webhook URLs) get break opportunities at
// their natural separators (@ . / - _) so they wrap cleanly inside narrow
// cells instead of overflowing; any segment still >14 chars is hard-chunked.
Font.registerHyphenationCallback((word) =>
  word.length > 20
    ? word
        .split(/(?<=[.@/_-])/)
        .flatMap((seg) => (seg.length > 14 ? (seg.match(/.{1,14}/g) ?? [seg]) : [seg]))
    : [word],
);

const s = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 42,
    paddingHorizontal: 43,
    fontFamily: SANS,
    fontSize: 9,
    lineHeight: 1.45,
    color: C.ink,
    backgroundColor: '#ffffff',
  },

  // ── Masthead
  masthead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingBottom: 9,
    borderBottomWidth: 2,
    borderBottomColor: C.ink,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  brandTick: { width: 6, height: 6, backgroundColor: C.azure, borderRadius: 1 },
  brand: {
    fontFamily: SANS_BOLD,
    fontSize: 8,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: C.soft,
  },
  docTitle: {
    marginTop: 5,
    fontFamily: SANS_BOLD,
    fontSize: 17,
    letterSpacing: -0.3,
    color: C.ink,
  },
  mastheadMeta: { alignItems: 'flex-end' },
  reqId: { fontFamily: MONO_BOLD, fontSize: 9.5, color: C.ink },
  submitted: { marginTop: 2, fontSize: 7.8, color: C.dim },
  status: {
    marginTop: 5,
    fontFamily: SANS_BOLD,
    fontSize: 6.5,
    lineHeight: 1,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingVertical: 2.5,
    paddingHorizontal: 7,
    borderRadius: 3,
    borderWidth: 1,
  },

  // ── High-volume banner
  hvBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 9,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: C.hvBannerBg,
    borderWidth: 1,
    borderColor: C.amberLine,
    borderLeftWidth: 4,
    borderLeftColor: C.amberDeep,
    borderRadius: 3,
  },
  hvBannerText: {
    fontFamily: SANS_BOLD,
    fontSize: 8,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: C.amber,
  },
  hvBannerSub: {
    marginLeft: 'auto',
    fontFamily: MONO,
    fontSize: 7.5,
    color: C.amberInk,
  },

  // ── Section scaffolding
  sec: { marginTop: 12 },
  secTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 4,
    marginBottom: 7,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  secTick: { width: 5.5, height: 5.5, backgroundColor: C.azure, borderRadius: 1 },
  secTitle: {
    fontFamily: SANS_BOLD,
    fontSize: 8,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: C.ink,
  },
  secNote: {
    marginLeft: 'auto',
    fontFamily: SANS_BOLD,
    fontSize: 6.5,
    letterSpacing: 0.5,
    color: C.faint,
  },
  missing: { fontSize: 8.5, color: C.dim },

  // ── Contact card
  contact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 8,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: C.line,
    borderLeftWidth: 3,
    borderLeftColor: C.azure,
    borderRadius: 3,
    backgroundColor: C.tint,
  },
  contactName: { fontFamily: SANS_BOLD, fontSize: 11.5, color: C.ink },
  contactCompany: { marginTop: 1, fontSize: 8, color: C.soft },
  contactLegal: { marginTop: 2, fontSize: 7, color: C.dim },

  klabel: {
    fontFamily: SANS_BOLD,
    fontSize: 6.3,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: C.dim,
    marginBottom: 1.5,
  },
  mono: { fontFamily: MONO_BOLD, fontSize: 8, color: C.ink },

  // ── Facts grid
  facts: { flexDirection: 'row', flexWrap: 'wrap' },
  fact: { width: '50%', paddingRight: 16, marginBottom: 7 },
  factValue: { fontSize: 8.5, lineHeight: 1.4, color: C.ink },

  // ── Red-flag callout
  redflag: {
    flexDirection: 'row',
    gap: 7,
    marginBottom: 8,
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderWidth: 1.2,
    borderColor: C.red,
    borderRadius: 3,
    backgroundColor: C.redTint,
  },
  redflagText: {
    flex: 1,
    fontFamily: SANS_BOLD,
    fontSize: 8,
    lineHeight: 1.45,
    color: C.red,
  },
  redflagTag: { letterSpacing: 0.6, textTransform: 'uppercase' },

  // ── Product blocks
  products: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 8,
  },
  product: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 3,
    paddingTop: 6,
    paddingHorizontal: 8,
    paddingBottom: 3,
  },
  productName: {
    fontFamily: SANS_BOLD,
    fontSize: 8,
    letterSpacing: 0.2,
    color: C.azure,
    marginBottom: 4,
  },
  pfRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 2.5,
    borderBottomWidth: 0.75,
    borderBottomColor: C.lineSoft,
  },
  pfLabel: { fontSize: 7.8, color: C.dim },
  pfValue: {
    fontFamily: SANS_BOLD,
    fontSize: 7.8,
    color: C.ink,
    textAlign: 'right',
    flexShrink: 1,
  },
  pfBlock: {
    paddingVertical: 2.5,
    borderBottomWidth: 0.75,
    borderBottomColor: C.lineSoft,
  },
  pfBlockText: { fontSize: 7.8, lineHeight: 1.4, color: C.ink },
  pfBlockMono: { fontFamily: MONO, fontSize: 7, color: C.ink },

  // ── IP chips
  ipList: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: 2 },
  ip: {
    fontFamily: MONO_BOLD,
    fontSize: 7,
    color: C.ink,
    backgroundColor: C.tint,
    borderWidth: 0.75,
    borderColor: C.line,
    borderRadius: 2,
    paddingVertical: 1,
    paddingHorizontal: 4,
  },

  // ── Capacity table
  capHead: {
    flexDirection: 'row',
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  capTh: {
    fontFamily: SANS_BOLD,
    fontSize: 6.3,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: C.dim,
    paddingRight: 8,
  },
  capRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: 0.75,
    borderBottomColor: C.lineSoft,
  },
  capCell: { fontSize: 8.5, color: C.ink, paddingRight: 8 },
  capNum: { fontFamily: MONO_BOLD, fontSize: 9 },
  capThreshold: { color: C.dim },
  verdict: {
    alignSelf: 'flex-start',
    fontFamily: SANS_BOLD,
    fontSize: 6.5,
    lineHeight: 1,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingVertical: 2.5,
    paddingHorizontal: 6,
    borderRadius: 2,
    borderWidth: 1,
  },

  // ── High-volume enhanced-KYC record
  hvRec: {
    marginTop: 8,
    paddingTop: 6,
    paddingHorizontal: 9,
    paddingBottom: 1,
    borderWidth: 1,
    borderColor: C.amberLine,
    borderRadius: 3,
    backgroundColor: C.hvRecBg,
  },
  hvRecTitle: {
    fontFamily: SANS_BOLD,
    fontSize: 7,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: C.amber,
    marginBottom: 5,
  },

  // ── Checklist
  checkItem: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
    borderBottomWidth: 0.75,
    borderBottomColor: C.lineSoft,
    borderBottomStyle: 'dashed',
  },
  checkbox: {
    width: 8,
    height: 8,
    marginTop: 1,
    borderWidth: 1.2,
    borderColor: C.dim,
    borderRadius: 1.5,
  },
  checkText: { flex: 1, fontSize: 8.5, lineHeight: 1.45, color: C.ink },

  // ── Footer
  foot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 14,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  footText: {
    fontSize: 6.3,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: C.faint,
  },
});

const STATUS_STYLE: Record<OnboardingRequest['status'], Style> = {
  pending: { color: C.azure, borderColor: C.azure, backgroundColor: C.azureTint },
  completed: { color: C.green, borderColor: C.green, backgroundColor: C.greenTint },
  rejected: { color: C.red, borderColor: C.red, backgroundColor: C.redTint },
};

// ─── Small pieces ─────────────────────────────────────────────────────────────

/** lucide AlertTriangle, redrawn as react-pdf SVG (stroke-only). */
function WarnIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M12 9v4" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      <Path d="M12 17h.01" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
    </Svg>
  );
}

function SectionTitle({ title, note }: { title: string; note?: string }) {
  return (
    <View style={s.secTitleRow}>
      <View style={s.secTick} />
      <Text style={s.secTitle}>{title}</Text>
      {note && <Text style={s.secNote}>{note}</Text>}
    </View>
  );
}

function IpChips({ ips }: { ips: string[] }) {
  return (
    <View style={s.ipList}>
      {ips.map((ip) => (
        <Text key={ip} style={s.ip}>{ip}</Text>
      ))}
    </View>
  );
}

/** One BriefFact — handles multi-line values, mono suffix/value, IP lists. */
function Fact({ fact }: { fact: BriefFact }) {
  return (
    <View style={s.fact} wrap={false}>
      <Text style={s.klabel}>{fact.label}</Text>
      {fact.ips ? (
        <IpChips ips={fact.ips} />
      ) : (
        <Text style={fact.monoValue ? s.mono : s.factValue}>
          {fact.value ?? '—'}
          {fact.monoSuffix != null && (
            <>
              {'  '}
              <Text style={s.mono}>{fact.monoSuffix}</Text>
            </>
          )}
        </Text>
      )}
    </View>
  );
}

function FactsGrid({ facts }: { facts: BriefFact[] }) {
  return (
    <View style={s.facts}>
      {facts.map((f) => (
        <Fact key={f.label} fact={f} />
      ))}
    </View>
  );
}

function ProductCard({ block, full }: { block: ProductBlock; full: boolean }) {
  const last = block.lines.length - 1;
  return (
    <View style={[s.product, { width: full ? '100%' : '48.75%' }]} wrap={false}>
      <Text style={s.productName}>{block.name}</Text>
      {block.lines.map((line, i) => {
        const noBorder = i === last ? { borderBottomWidth: 0 } : undefined;
        if (line.kind === 'fact') {
          return (
            <View key={line.label} style={[s.pfRow, noBorder ?? {}]}>
              <Text style={s.pfLabel}>{line.label}</Text>
              <Text style={s.pfValue}>{line.value || '—'}</Text>
            </View>
          );
        }
        if (line.kind === 'ips') {
          return (
            <View key={line.label} style={[s.pfBlock, noBorder ?? {}]}>
              <Text style={s.klabel}>{line.label}</Text>
              <IpChips ips={line.ips} />
            </View>
          );
        }
        return (
          <View key={line.label} style={[s.pfBlock, noBorder ?? {}]}>
            <Text style={s.klabel}>{line.label}</Text>
            <Text style={line.mono ? s.pfBlockMono : s.pfBlockText}>
              {line.value || '—'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── The document ─────────────────────────────────────────────────────────────

function BriefPdfDocument({ request }: { request: OnboardingRequest }) {
  const kyc = request.kyc;
  const isHighVolume = kyc?.high_volume != null;
  const legalName = kyc?.standard.legal_business_name;
  const kycFacts = kyc ? buildKycFacts(kyc) : null;
  const hvFacts = kyc ? buildHvFacts(kyc) : null;
  const productsModel = buildProductsModel(request);
  const capacity = buildCapacityModel(kyc);
  const checklist = buildActionChecklist(request);
  const fullWidthProducts = productsModel.blocks.length === 1;

  return (
    <Document
      title={`${BRIEF_TITLE} — Request #${request.id}`}
      author={BRIEF_BRAND}
      subject="Solutions Engineering onboarding intake brief"
    >
      <Page size="LETTER" style={s.page}>
        {/* Masthead */}
        <View style={s.masthead} wrap={false}>
          <View>
            <View style={s.brandRow}>
              <View style={s.brandTick} />
              <Text style={s.brand}>{BRIEF_BRAND}</Text>
            </View>
            <Text style={s.docTitle}>{BRIEF_TITLE}</Text>
          </View>
          <View style={s.mastheadMeta}>
            <Text style={s.reqId}>REQUEST #{request.id}</Text>
            <Text style={s.submitted}>Submitted {fmtBriefDate(request.created_at)}</Text>
            <Text style={[s.status, STATUS_STYLE[request.status]]}>
              {STATUS_LABELS[request.status]}
            </Text>
          </View>
        </View>

        {/* High-volume banner */}
        {isHighVolume && (
          <View style={s.hvBanner} wrap={false}>
            <WarnIcon size={11} color={C.amber} />
            <Text style={s.hvBannerText}>{HV_BANNER_TITLE}</Text>
            <Text style={s.hvBannerSub}>{hvBannerSub(kyc)}</Text>
          </View>
        )}

        {/* Contact card — who the SE calls */}
        <View style={s.sec} wrap={false}>
          <SectionTitle title="Contact" />
          <View style={s.contact}>
            <View style={{ flex: 1.35 }}>
              <Text style={s.contactName}>{request.contact_name}</Text>
              <Text style={s.contactCompany}>{request.company_name}</Text>
              {legalName && legalName !== request.company_name && (
                <Text style={s.contactLegal}>Legal: {legalName}</Text>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.klabel}>Email</Text>
              <Text style={s.mono}>{request.email}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.klabel}>Phone</Text>
              <Text style={s.mono}>{request.phone ? fmt(request.phone) : '—'}</Text>
            </View>
          </View>
        </View>

        {/* Business verification (KYC) */}
        <View style={s.sec} wrap={false}>
          <SectionTitle title="Business Verification (KYC)" note={kyc ? 'FCC 26-27' : undefined} />
          {kycFacts ? (
            <>
              {kyc?.standard.address_is_registered_agent_or_virtual && (
                <View style={s.redflag} wrap={false}>
                  <WarnIcon size={10} color={C.red} />
                  <Text style={s.redflagText}>
                    <Text style={s.redflagTag}>Red flag{'   '}</Text>
                    {RED_FLAG_TEXT}
                  </Text>
                </View>
              )}
              <FactsGrid facts={kycFacts} />
            </>
          ) : (
            <Text style={s.missing}>Not captured (pre-KYC intake).</Text>
          )}
        </View>

        {/* Requested products */}
        <View style={s.sec} wrap={false}>
          <SectionTitle title="Requested Products" note={productsModel.note} />
          <View style={s.products}>
            {productsModel.blocks.map((block) => (
              <ProductCard key={block.key} block={block} full={fullWidthProducts} />
            ))}
          </View>
        </View>

        {/* Capacity & compliance */}
        <View style={s.sec} wrap={false}>
          <SectionTitle title="Capacity & Compliance" note="Granite high-volume thresholds" />
          {capacity.missingNote ? (
            <Text style={s.missing}>{capacity.missingNote}</Text>
          ) : (
            <View>
              <View style={s.capHead}>
                <Text style={[s.capTh, { width: '34%' }]}>Metric</Text>
                <Text style={[s.capTh, { width: '16%' }]}>Declared</Text>
                <Text style={[s.capTh, { width: '28%' }]}>Granite Threshold</Text>
                <Text style={[s.capTh, { width: '22%' }]}>Verdict</Text>
              </View>
              {capacity.rows.map((row) => (
                <View key={row.metric} style={s.capRow}>
                  <Text style={[s.capCell, { width: '34%' }]}>{row.metric}</Text>
                  <Text style={[s.capCell, s.capNum, { width: '16%' }]}>
                    {row.declared ?? '—'}
                  </Text>
                  <Text style={[s.capCell, s.capThreshold, { width: '28%' }]}>
                    {row.threshold}
                  </Text>
                  <View style={{ width: '22%' }}>
                    {row.over == null ? (
                      <Text style={s.capCell}>—</Text>
                    ) : (
                      <Text
                        style={[
                          s.verdict,
                          row.over
                            ? { color: C.red, borderColor: C.red, backgroundColor: C.redTint }
                            : { color: C.green, borderColor: C.green, backgroundColor: C.greenTint },
                        ]}
                      >
                        {row.over ? 'Over — high-volume' : 'Within threshold'}
                      </Text>
                    )}
                  </View>
                </View>
              ))}
            </View>
          )}

          {hvFacts && (
            <View style={s.hvRec} wrap={false}>
              <Text style={s.hvRecTitle}>FCC 26-27 Enhanced-KYC Record (High-Volume)</Text>
              <FactsGrid facts={hvFacts} />
            </View>
          )}
        </View>

        {/* SE action checklist */}
        <View style={s.sec} wrap={false}>
          <SectionTitle
            title="Solutions Engineering — Action Checklist"
            note="Auto-composed from submission"
          />
          {checklist.map((item, i) => (
            <View
              key={item.text}
              style={[
                s.checkItem,
                i === checklist.length - 1 ? { borderBottomWidth: 0 } : {},
              ]}
              wrap={false}
            >
              <View style={[s.checkbox, item.critical ? { borderColor: C.red } : {}]} />
              <Text
                style={[
                  s.checkText,
                  item.critical ? { color: C.red, fontFamily: SANS_BOLD } : {},
                ]}
              >
                {item.text}
              </Text>
            </View>
          ))}
        </View>

        {/* Footer */}
        <View style={s.foot} wrap={false}>
          <Text style={s.footText}>{FOOTER_LEFT}</Text>
          <Text style={s.footText}>{footerRight()}</Text>
        </View>
      </Page>
    </Document>
  );
}

// ─── Download entry point ─────────────────────────────────────────────────────

/**
 * Generates the brief PDF client-side and triggers a direct browser
 * download as crag-intake-brief-{id}.pdf. Throws on generation failure —
 * callers surface a toast.
 */
export async function downloadBriefPdf(request: OnboardingRequest): Promise<void> {
  const blob = await pdf(<BriefPdfDocument request={request} />).toBlob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = briefFileName(request.id);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Delay revocation so the click's navigation grabs the blob first.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
