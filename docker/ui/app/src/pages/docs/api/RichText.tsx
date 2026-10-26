/**
 * RichText — the API Reference's only markup: a `backtick span` in a content
 * string renders as inline code (the docs' `.dlx-ic` chip). Everything else
 * is plain text, so content stays data and React escapes it.
 */
import { Fragment } from 'react';

export function RichText({ text }: { text: string }) {
  // "a `b` c" → ['a ', 'b', ' c']: odd indexes were inside backticks.
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="dlx-ic">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
