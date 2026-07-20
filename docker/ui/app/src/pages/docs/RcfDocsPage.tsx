/**
 * RCF User Guide — concise customer-facing documentation for Granite Shale RCF.
 *
 * THIN page: composition only. The frosted-glass primitives, styles, and section
 * content live in the co-located feature folder (see docs/FRONTEND_GLASS_REFACTOR.md):
 *   styles.ts        → tokens + style builders (blue glass)
 *   types.ts         → local types
 *   components/      → DocsPageHeader, DocsAccordion, text/code/apiRefs, sections
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout; this page only
 * composes glass surfaces on top. No top padding — the layout owns the offset.
 */

import { DocsPageHeader } from './components/DocsPageHeader';
import {
  GettingStartedSection,
  ManagingRcfSection,
  DIDManagementSection,
  SupportSection,
} from './components/RcfSections';
import { readingColumn, sectionList } from './styles';

export function RcfDocsPage() {
  return (
    <>
      <DocsPageHeader
        eyebrow="Customer Guide"
        title="Granite Shale RCF"
        subtitle="Manage your Remote Call Forwarding numbers"
      />

      <div style={readingColumn}>
        <div style={sectionList}>
          <GettingStartedSection />
          <ManagingRcfSection />
          <DIDManagementSection />
          <SupportSection />
        </div>
      </div>
    </>
  );
}
