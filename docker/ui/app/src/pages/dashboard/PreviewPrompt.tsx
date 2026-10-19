/**
 * PreviewPrompt — shown on a customer page (Dashboard, /rcf) when an admin is
 * in "View as Customer" but no preview customer is picked yet (the list is
 * still loading, or there are no customers). Carries the same picker as the
 * sidebar so the page is never a dead end.
 */
import { Eye } from 'lucide-react';
import { CustomerPreviewPicker } from '../../components/preview/CustomerPreviewPicker';
import '../../styles/account-dashboard.css';

export function PreviewPrompt() {
  return (
    <div className="rcf-scope ad-scope">
      <div className="ad-shell">
        <section className="ad-card ad-prompt" aria-labelledby="ad-prompt-title">
          <span className="ad-prompt-icon" aria-hidden="true">
            <Eye size={22} strokeWidth={2} />
          </span>
          <h1 id="ad-prompt-title" className="ad-prompt-title">Pick a customer to preview</h1>
          <p className="ad-quiet">
            Customer view shows the app exactly as one customer sees it. Choose whose account to look at — you can
            switch any time from the sidebar.
          </p>
          <div className="ad-prompt-picker">
            <CustomerPreviewPicker tone="light" label="Customer" />
          </div>
        </section>
      </div>
    </div>
  );
}
