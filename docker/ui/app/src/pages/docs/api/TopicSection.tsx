/**
 * TopicSection — a Getting started topic (prose, code, a short table, a
 * note), always open: these are the page's primary reading. A long table
 * shows its first rows and "Show all N …" (kit useShowMore, §20.3).
 * React #310: hooks only at the top of their components.
 */
import { ShowMoreButton, useShowMore } from '../../../components/layout/kit';
import { Callout, CodeBlock } from '../shared';
import { RichText } from './RichText';
import type { TopicBlock, TopicDoc } from './types';

type TableBlock = Extract<TopicBlock, { type: 'table' }>;

function TopicTable({ block }: { block: TableBlock }) {
  // ALL hooks unconditionally at the top (React #310).
  const more = useShowMore(block.rows, block.limit ?? Number.POSITIVE_INFINITY);
  return (
    <>
      <div className="dlx-table-wrap dxa-table-wrap">
        <table className="dlx-table dxa-table">
          <thead>
            <tr>
              <th className="dl-th" scope="col">
                {block.head[0]}
              </th>
              <th className="dl-th" scope="col">
                {block.head[1]}
              </th>
            </tr>
          </thead>
          <tbody id={more.listId}>
            {more.visible.map(([a, b]) => (
              <tr key={a}>
                <td className="dxa-td-name dxa-td-term">
                  <RichText text={a} />
                </td>
                <td>
                  <RichText text={b} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more.needed && (
        <div className="dxa-more">
          <ShowMoreButton {...more.buttonProps} noun={block.noun ?? 'rows'} />
        </div>
      )}
    </>
  );
}

function Block({ block }: { block: TopicBlock }) {
  switch (block.type) {
    case 'p':
      return (
        <p className="dlx-p dxa-p">
          <RichText text={block.text} />
        </p>
      );
    case 'list':
      return (
        <ul className="dlx8-ul dxa-ul">
          {block.items.map((item) => (
            <li key={item}>
              <RichText text={item} />
            </li>
          ))}
        </ul>
      );
    case 'code':
      return <CodeBlock code={block.code} label={block.label} />;
    case 'table':
      return <TopicTable block={block} />;
    case 'callout':
      return (
        <Callout tone={block.tone}>
          <RichText text={block.text} />
        </Callout>
      );
  }
}

export function TopicSection({ topic }: { topic: TopicDoc }) {
  return (
    <section className="dxa-topic" aria-labelledby={`api-${topic.id}-h`}>
      <h4 className="dxa-topic-title" id={`api-${topic.id}-h`} tabIndex={-1}>
        {topic.title}
      </h4>
      {topic.blocks.map((block, i) => (
        <Block key={`${block.type}-${i}`} block={block} />
      ))}
    </section>
  );
}
