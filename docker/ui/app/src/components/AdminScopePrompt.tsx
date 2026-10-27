/**
 * AdminScopePrompt — the "pick a customer first" card of the prompt-first
 * staff pages: Visual Voicemail, Reporting and IVR open with nothing chosen
 * (no `?customer=`) and show this under the page header, whose picker
 * (AdminCustomerPicker) does the choosing.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │                    [ 👥 ]                     │
 *   │  Select a customer to see their voicemail     │
 *   │  Use the Viewing menu to choose a customer,   │
 *   │  or All customers.                            │
 *   └──────────────────────────────────────────────┘
 *
 * Built on the daylight console's centred page state (`dl-panel` +
 * `dl-center` + `dl-center-icon`) — the same pattern these pages use for
 * their own loading / empty / error states, so it reads as part of each
 * page. (The RCF console keeps its own `ad-prompt` card: it lives in the
 * granite dashboard family, not the daylight console.)
 */
import { useId, type ReactNode } from 'react';
import { Users } from 'lucide-react';
import '../styles/admin-scope.css';

export interface AdminScopePromptProps {
  /** One line, e.g. "Select a customer to see their voicemail". */
  title: string;
  /** The page's own picker label ("Viewing", "Customer"), named in the hint. */
  pickerLabel: string;
  /** Overrides the default hint line. */
  children?: ReactNode;
  /** Defaults to a people glyph. */
  icon?: ReactNode;
}

export function AdminScopePrompt({ title, pickerLabel, children, icon }: AdminScopePromptProps) {
  const titleId = useId();
  return (
    <section className="dl-panel asp" aria-labelledby={titleId}>
      <div className="dl-center asp-body">
        <span className="dl-center-icon" aria-hidden="true">
          {icon ?? <Users size={26} strokeWidth={2} />}
        </span>
        <h2 id={titleId} className="asp-title">
          {title}
        </h2>
        {children ?? (
          <p className="asp-copy">
            Use the <strong>{pickerLabel}</strong> menu to choose a customer, or All customers.
          </p>
        )}
      </div>
    </section>
  );
}
