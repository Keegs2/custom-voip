/**
 * KeywordGuide — "What can I say?" (docs/IVR_ASSIST_INTERFACES.md §6): the
 * vocabulary as readable sections of phrase chips, the customer's own
 * number names (the "Your numbers" the table refers to), the limits, and the
 * three example requests — choosing one puts it in the message box.
 *
 * All wording comes from guide.ts (the contract's text). Pure presentation:
 * no store, no queries, so it renders anywhere (and server-side in its test).
 */
import { useId } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { GUIDE_EXAMPLES, GUIDE_INTRO, GUIDE_LIMITS, VOCABULARY, type GuidePhrase } from './guide';

export interface GuideNumber {
  /** The number's name, or its formatted number when it has none. */
  name: string;
  /** What it is, e.g. "Call forwarding" / "Voicemail". */
  kind: string;
}

export interface KeywordGuideProps {
  /** Puts an example request in the message box. */
  onUseExample: (text: string) => void;
  /** The message box is closed (a job is running, or a proposal awaits a choice). */
  examplesDisabled?: boolean;
  /** The account's numbers a request can name (this flow's own numbers left out). */
  numbers?: readonly GuideNumber[];
}

function Phrase({ phrase }: { phrase: GuidePhrase }) {
  if ('say' in phrase) return <li className="ivr-asg-chip">“{phrase.say}”</li>;
  return (
    <li className="ivr-asg-chip ivr-asg-chip-hint">
      {phrase.hint}
      {phrase.strong && (
        <>
          {' '}
          <strong>{phrase.strong}</strong>
        </>
      )}
    </li>
  );
}

export function KeywordGuide({ onUseExample, examplesDisabled = false, numbers = [] }: KeywordGuideProps) {
  const id = useId();
  return (
    <section className="ivr-asg" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="ivr-asg-title">
        What can I say?
      </h3>
      <p className="ivr-asg-intro">{GUIDE_INTRO}</p>

      <ul className="ivr-asg-rows">
        {VOCABULARY.map((row) => (
          <li key={row.get} className="ivr-asg-row">
            <h4 className="ivr-asg-get">{row.get}</h4>
            <ul className="ivr-asg-phrases" aria-label={`Say things like (${row.get})`}>
              {row.phrases.map((p, i) => (
                <Phrase key={i} phrase={p} />
              ))}
            </ul>
            <p className="ivr-asg-builds">
              Builds <span className="ivr-asg-block">{row.builds}</span>
            </p>
          </li>
        ))}
      </ul>

      <h4 className="ivr-asg-sub">Your numbers</h4>
      {numbers.length === 0 ? (
        <p className="ivr-asg-note">Your numbers appear here by name once they load.</p>
      ) : (
        <ul className="ivr-asg-phrases ivr-asg-numbers" aria-label="Names you can use">
          {numbers.map((n, i) => (
            <li key={`${n.name}-${i}`} className="ivr-asg-chip ivr-asg-chip-number">
              {n.name}
              <span className="ivr-asg-kind">{n.kind}</span>
            </li>
          ))}
        </ul>
      )}

      <h4 className="ivr-asg-sub">Good to know</h4>
      <ul className="ivr-asg-limits">
        {GUIDE_LIMITS.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>

      <h4 className="ivr-asg-sub" id={`${id}-ex`}>
        Try an example
      </h4>
      <ul className="ivr-asg-examples" aria-labelledby={`${id}-ex`}>
        {GUIDE_EXAMPLES.map((text, i) => (
          <li key={i}>
            <button
              type="button"
              className="ivr-asg-example"
              disabled={examplesDisabled}
              onClick={() => onUseExample(text)}
              data-example={i + 1}
            >
              <span className="ivr-asg-example-text">{text}</span>
              <span className="ivr-asg-example-use" aria-hidden="true">
                <CornerDownLeft size={12} /> Use this
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
