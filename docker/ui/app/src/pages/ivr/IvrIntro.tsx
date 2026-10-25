/**
 * IvrIntro — /ivr for an account without IVR: what it does, shown with a
 * miniature of a real flow (the same block hues as the builder), and how to
 * get it. Staff are pointed at TED, where the entitlement lives.
 */
import { CalendarClock, Phone, Voicemail } from 'lucide-react';

const KEYS: { key: string; label: string }[] = [
  { key: '1', label: 'Sales' },
  { key: '2', label: 'Service' },
  { key: '9', label: 'Hear it again' },
];

export function IvrIntro({ staff }: { staff: boolean }) {
  return (
    <section className="dl-panel ivr-intro" aria-labelledby="ivr-intro-title">
      <div className="ivr-intro-art" aria-hidden="true">
        <div className="ivr-mini ivr-mini-entry">
          <span className="ivr-mini-dot" /> A caller dials your IVR number
        </div>
        <div className="ivr-mini-link" />
        <div className="ivr-mini ivr-mini-play">
          <span className="ivr-mini-kind">Play message</span>
          “Thanks for calling. For sales press 1, for service press 2.”
        </div>
        <div className="ivr-mini-link" />
        <div className="ivr-mini ivr-mini-menu">
          <span className="ivr-mini-kind">Menu</span>
          <span className="ivr-mini-keys">
            {KEYS.map((k) => (
              <span key={k.key} className="ivr-mini-keyrow">
                <span className="ivr-key">{k.key}</span>
                {k.label}
              </span>
            ))}
          </span>
        </div>
        <div className="ivr-mini-branches">
          <div className="ivr-mini ivr-mini-dial">
            <Phone size={13} /> Transfer to your sales line
          </div>
          <div className="ivr-mini ivr-mini-voicemail">
            <Voicemail size={13} /> No answer? Voicemail
          </div>
        </div>
      </div>
      <div className="ivr-intro-copy">
        <h2 id="ivr-intro-title" className="ivr-intro-title">
          Answer calls with a menu you design
        </h2>
        <p className="ivr-intro-lead">
          Draw the call on a canvas — greetings, menus, business hours and transfers — test it, then publish it to
          your IVR numbers.
        </p>
        <ul className="ivr-intro-points">
          <li>
            <span className="ivr-key" aria-hidden="true">1</span>
            Greet callers and let them choose with the keypad, with a second try when nobody presses anything.
          </li>
          <li>
            <span className="ivr-intro-ic" aria-hidden="true">
              <CalendarClock size={14} />
            </span>
            Route by your opening hours and holidays, or by the number that is calling.
          </li>
          <li>
            <span className="ivr-intro-ic" aria-hidden="true">
              <Phone size={14} />
            </span>
            Send callers to your call-forwarding numbers, voicemail boxes, other IVRs or any US number.
          </li>
        </ul>
        <div className="ivr-intro-status">
          <strong>IVR isn’t on this account yet.</strong>{' '}
          {staff
            ? 'Turn it on for this customer in TED (Customer 360 → Products) and assign an IVR number.'
            : 'Your Granite account team can add it and assign your IVR numbers.'}
        </div>
      </div>
    </section>
  );
}
