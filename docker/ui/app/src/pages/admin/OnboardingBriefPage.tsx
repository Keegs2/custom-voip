/**
 * OnboardingBriefPage — on-screen PREVIEW of the SE Onboarding Intake Brief
 * (/admin/onboarding/print/:id, RequireAdmin, full-screen outside AppLayout).
 *
 * ALL content comes from briefContent.ts — the same model that drives the
 * downloadable PDF (onboardingBriefPdf.tsx) — so preview and artifact
 * cannot drift. This page is now purely a letter-size on-screen preview:
 * the primary "Download PDF" action (here and on the onboarding queue)
 * generates a real .pdf client-side; window.print() remains available as a
 * secondary hard-copy path but is no longer auto-triggered.
 *
 * Styling: styles/onboarding-brief.css (`obb-*`) — dark ink on white,
 * Archivo/Public Sans with system fallbacks, `break-inside: avoid` on
 * every block.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Download, Printer } from 'lucide-react';
import { getOnboardingRequest } from '../../api/onboarding';
import type { OnboardingRequest, OnboardingStatus } from '../../types/onboarding';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
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
  buildActionChecklist,
  buildCapacityModel,
  buildHvFacts,
  buildKycFacts,
  buildProductsModel,
  fmtBriefDate,
  footerRight,
  hvBannerSub,
} from './briefContent';
import '../../styles/onboarding-brief.css';

const STATUS_CLS: Record<OnboardingStatus, string> = {
  pending: 'obb-status-pending',
  completed: 'obb-status-completed',
  rejected: 'obb-status-rejected',
};

// ─── Small presentational pieces ──────────────────────────────────────────────

function IpList({ ips }: { ips: string[] }) {
  return (
    <div className="obb-iplist">
      {ips.map((ip) => (
        <span key={ip} className="obb-ip">{ip}</span>
      ))}
    </div>
  );
}

/** One BriefFact — multi-line values, mono suffix/value, IP chip lists. */
function Fact({ fact }: { fact: BriefFact }) {
  const lines = (fact.value ?? '—').split('\n');
  return (
    <div>
      <span className="obb-klabel">{fact.label}</span>
      <div className={fact.monoValue ? 'obb-mono' : 'obb-fact-value'}>
        {fact.ips ? (
          <IpList ips={fact.ips} />
        ) : (
          <>
            {lines.map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
            {fact.monoSuffix != null && (
              <>
                {' '}
                <span className="obb-mono">{fact.monoSuffix}</span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FactsGrid({ facts }: { facts: BriefFact[] }) {
  return (
    <div className="obb-facts">
      {facts.map((f) => (
        <Fact key={f.label} fact={f} />
      ))}
    </div>
  );
}

function ProductCard({ block }: { block: ProductBlock }) {
  return (
    <div className="obb-product">
      <h3 className="obb-product-name">{block.name}</h3>
      {block.lines.map((line) => {
        if (line.kind === 'fact') {
          return (
            <div key={line.label} className="obb-pf">
              <span className="obb-pf-label">{line.label}</span>
              <span className="obb-pf-value">{line.value || '—'}</span>
            </div>
          );
        }
        if (line.kind === 'ips') {
          return (
            <div key={line.label} className="obb-pf-block">
              <span className="obb-pf-label">{line.label}</span>
              <IpList ips={line.ips} />
            </div>
          );
        }
        return (
          <div key={line.label} className="obb-pf-block">
            <span className="obb-pf-label">{line.label}</span>
            <p className={line.mono ? 'obb-mono' : undefined} style={line.mono ? { fontSize: 10 } : undefined}>
              {line.value || '—'}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ─── The brief document (HTML preview of the same model as the PDF) ───────────

function BriefDocument({ request }: { request: OnboardingRequest }) {
  const kyc = request.kyc;
  const isHighVolume = kyc?.high_volume != null;
  const legalName = kyc?.standard.legal_business_name;
  const kycFacts = kyc ? buildKycFacts(kyc) : null;
  const hvFacts = kyc ? buildHvFacts(kyc) : null;
  const productsModel = buildProductsModel(request);
  const capacity = buildCapacityModel(kyc);
  const checklist = buildActionChecklist(request);

  return (
    <div className="obb-sheet">
      {/* Masthead */}
      <header className="obb-masthead">
        <div>
          <div className="obb-brand">{BRIEF_BRAND}</div>
          <h1 className="obb-doc-title">{BRIEF_TITLE}</h1>
        </div>
        <div className="obb-masthead-meta">
          <div className="obb-req-id">REQUEST #{request.id}</div>
          <div className="obb-submitted">Submitted {fmtBriefDate(request.created_at)}</div>
          <span className={`obb-status ${STATUS_CLS[request.status]}`}>
            {STATUS_LABELS[request.status]}
          </span>
        </div>
      </header>

      {/* High-volume banner */}
      {isHighVolume && (
        <div className="obb-hv-banner">
          <AlertTriangle size={15} strokeWidth={2.5} />
          {HV_BANNER_TITLE}
          <span className="obb-hv-banner-sub">{hvBannerSub(kyc)}</span>
        </div>
      )}

      {/* Contact card — visually first: this is who the SE calls */}
      <section className="obb-sec">
        <h2 className="obb-sec-title">Contact</h2>
        <div className="obb-contact">
          <div>
            <div className="obb-contact-name">{request.contact_name}</div>
            <div className="obb-contact-company">{request.company_name}</div>
            {legalName && legalName !== request.company_name && (
              <div className="obb-contact-legal">Legal: {legalName}</div>
            )}
          </div>
          <div className="obb-contact-cell">
            <span className="obb-klabel">Email</span>
            <a className="obb-mono" href={`mailto:${request.email}`}>{request.email}</a>
          </div>
          <div className="obb-contact-cell">
            <span className="obb-klabel">Phone</span>
            <span className="obb-mono">{request.phone ? fmt(request.phone) : '—'}</span>
          </div>
        </div>
      </section>

      {/* Business verification (KYC) */}
      <section className="obb-sec">
        <h2 className="obb-sec-title">
          Business Verification (KYC)
          {kyc && <span className="obb-sec-title-note">FCC 26-27</span>}
        </h2>
        {kycFacts ? (
          <>
            {kyc?.standard.address_is_registered_agent_or_virtual && (
              <div className="obb-redflag">
                <AlertTriangle size={14} strokeWidth={2.5} />
                <div>
                  <span className="obb-redflag-tag">Red flag</span>
                  {RED_FLAG_TEXT}
                </div>
              </div>
            )}
            <FactsGrid facts={kycFacts} />
          </>
        ) : (
          <p className="obb-missing">Not captured (pre-KYC intake).</p>
        )}
      </section>

      {/* Requested products */}
      <section className="obb-sec">
        <h2 className="obb-sec-title">
          Requested Products
          <span className="obb-sec-title-note">{productsModel.note}</span>
        </h2>
        <div className="obb-products">
          {productsModel.blocks.map((block) => (
            <ProductCard key={block.key} block={block} />
          ))}
        </div>
      </section>

      {/* Capacity & compliance */}
      <section className="obb-sec">
        <h2 className="obb-sec-title">
          Capacity &amp; Compliance
          <span className="obb-sec-title-note">Granite high-volume thresholds</span>
        </h2>

        {capacity.missingNote ? (
          <p className="obb-missing">{capacity.missingNote}</p>
        ) : (
          <table className="obb-captable">
            <thead>
              <tr>
                <th style={{ width: '34%' }}>Metric</th>
                <th style={{ width: '16%' }}>Declared</th>
                <th style={{ width: '28%' }}>Granite Threshold</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {capacity.rows.map((row) => (
                <tr key={row.metric}>
                  <td>{row.metric}</td>
                  <td className="obb-cap-num">{row.declared ?? '—'}</td>
                  <td className="obb-cap-threshold">{row.threshold}</td>
                  <td>
                    {row.over == null ? (
                      '—'
                    ) : (
                      <span
                        className={
                          row.over
                            ? 'obb-verdict obb-verdict-over'
                            : 'obb-verdict obb-verdict-under'
                        }
                      >
                        {row.over ? 'Over — high-volume' : 'Within threshold'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {hvFacts && (
          <div className="obb-hvrec">
            <h3 className="obb-hvrec-title">FCC 26-27 Enhanced-KYC Record (High-Volume)</h3>
            <FactsGrid facts={hvFacts} />
          </div>
        )}
      </section>

      {/* SE action checklist */}
      <section className="obb-sec">
        <h2 className="obb-sec-title">
          Solutions Engineering — Action Checklist
          <span className="obb-sec-title-note">Auto-composed from submission</span>
        </h2>
        <ul className="obb-check">
          {checklist.map((item) => (
            <li key={item.text} className={item.critical ? 'obb-check-critical' : undefined}>
              <span className="obb-checkbox" aria-hidden="true" />
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="obb-foot">
        <span>{FOOTER_LEFT}</span>
        <span>{footerRight()}</span>
      </footer>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function OnboardingBriefPage() {
  // ALL hooks unconditionally at the top — React rules-of-hooks
  const { id } = useParams<{ id: string }>();
  const [downloading, setDownloading] = useState(false);
  const { toastErr } = useToast();

  const requestId = Number(id);
  const validId = Number.isInteger(requestId) && requestId > 0;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['onboarding-brief', requestId],
    queryFn: () => getOnboardingRequest(requestId),
    enabled: validId,
  });

  const handleDownload = async () => {
    if (!data || downloading) return;
    setDownloading(true);
    try {
      // Dynamic import keeps @react-pdf/renderer out of the main bundle.
      const { downloadBriefPdf } = await import('./onboardingBriefPdf');
      await downloadBriefPdf(data);
    } catch {
      toastErr('PDF generation failed — try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="obb-scope">
      {/* Screen-only toolbar */}
      <div className="obb-toolbar obb-noprint">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Link to="/admin/onboarding" className="obb-btn obb-btn-quiet">
            <ArrowLeft size={14} /> Queue
          </Link>
          <span className="obb-toolbar-note">
            On-screen preview — Download PDF saves the brief to your downloads.
          </span>
        </div>
        <div className="obb-toolbar-actions">
          <button
            type="button"
            className="obb-btn obb-btn-quiet"
            onClick={() => window.print()}
          >
            <Printer size={14} /> Print
          </button>
          <button
            type="button"
            className="obb-btn"
            onClick={handleDownload}
            disabled={!data || downloading}
          >
            {downloading ? <Spinner size="xs" /> : <Download size={14} />}
            {downloading ? 'Generating…' : 'Download PDF'}
          </button>
        </div>
      </div>

      {(!validId || isError) && (
        <div className="obb-state obb-noprint">
          {validId ? 'Failed to load onboarding request.' : 'Invalid request ID.'}
        </div>
      )}

      {validId && isLoading && (
        <div className="obb-state obb-noprint">
          <Spinner /> Preparing brief…
        </div>
      )}

      {data && <BriefDocument request={data} />}
    </div>
  );
}
