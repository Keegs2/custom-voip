/**
 * API Reference — comprehensive developer documentation for the Granite Shale
 * REST API. Covers authentication, RCF endpoints, number inventory, and
 * integration patterns.
 *
 * THIN page: composition only. Section content + frosted-glass primitives live
 * in the co-located feature folder (styles.ts / types.ts / components/). The
 * ambient GlassBackground is mounted app-wide by AppLayout — this page just
 * composes glass surfaces on top, with no top padding (layout owns the offset).
 */

import { DocsPageHeader } from './components/DocsPageHeader';
import {
  ApiGettingStartedSection,
  ApiRcfSection,
  ApiNumbersSection,
  ApiIntegrationSection,
} from './components/ApiSections';
import { readingColumn, sectionList } from './styles';

export function ApiDocsPage() {
  return (
    <>
      <DocsPageHeader
        eyebrow="Developer Reference"
        title="API Reference"
        subtitle="RESTful API documentation for programmatic access to the Granite Shale platform"
      />

      <div style={readingColumn}>
        <div style={sectionList}>
          <ApiGettingStartedSection />
          <ApiRcfSection />
          <ApiNumbersSection />
          <ApiIntegrationSection />
        </div>
      </div>
    </>
  );
}
