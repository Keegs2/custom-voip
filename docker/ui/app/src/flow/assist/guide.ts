/**
 * guide.ts — the "What can I say?" keyword guide and the disclosure, word
 * for word from docs/IVR_ASSIST_INTERFACES.md §6. The same table is taught
 * by the reviewed prompt on the other side, so DO NOT reword anything here
 * without a contract change. Pure data (the guide component renders it, the
 * self-tests check it).
 *
 * A phrase is either something to say (`say`, shown in quotes) or a
 * description of what fits there (`hint`, e.g. "a US number").
 *
 * One wording change, deliberate: the contract's "Builds" column names two
 * config keys (`tz`, `passCallerId`); customers see "time zone" and
 * "caller ID" for them instead of the code names. Apostrophes are the
 * contract's straight ones, so an example sent from the guide is byte-for-
 * byte the contract's text.
 */

export type GuidePhrase = { say: string } | { hint: string; strong?: string };

export interface GuideRow {
  /** "To get" */
  get: string;
  /** "Say things like" */
  phrases: readonly GuidePhrase[];
  /** "Builds" */
  builds: string;
}

const say = (s: string): GuidePhrase => ({ say: s });

export const VOCABULARY: readonly GuideRow[] = [
  {
    get: 'A greeting or announcement',
    phrases: [say('greet callers with …'), say('say …'), say('play …'), say('announce …')],
    builds: 'Play message',
  },
  {
    get: 'A menu',
    phrases: [say('press 1 for billing, 2 for outages'), say('menu options'), say('if they press 3 …')],
    builds: 'Menu',
  },
  {
    get: 'Menu behaviour',
    phrases: [
      say('repeat the menu twice'),
      say('wait 8 seconds'),
      say("if they don't press anything …"),
      say('if they press a wrong key …'),
    ],
    builds: 'Menu retries / timeout / no key / wrong key',
  },
  {
    get: 'Opening hours',
    phrases: [
      say('business hours'),
      say('weekdays 8 to 5'),
      say('Monday–Friday 9–6, Saturday 10–2'),
      say('after hours'),
      say('on weekends'),
      say('closed on Dec 25'),
    ],
    builds: 'Business hours',
  },
  {
    get: 'A time zone',
    phrases: [
      say('Eastern'),
      say('Central'),
      say('Mountain'),
      say('Arizona'),
      say('Pacific'),
      say('Alaska'),
      say('Hawaii'),
      say('Puerto Rico'),
    ],
    builds: 'Business hours time zone',
  },
  {
    get: 'Who is calling',
    phrases: [say('if the caller is from 617'), say("if the caller's number is …"), say('blocked or private callers')],
    builds: 'Caller check',
  },
  {
    get: 'A transfer',
    phrases: [
      say('transfer to …'),
      say('send them to …'),
      say('forward to …'),
      say('ring …'),
      { hint: 'a name from', strong: 'Your numbers' },
      { hint: 'a US number' },
    ],
    builds: 'Transfer',
  },
  {
    get: 'Caller ID on a transfer',
    phrases: [say("show the caller's number"), say('show our number instead')],
    builds: 'Transfer caller ID',
  },
  {
    get: 'Ring time',
    phrases: [say('ring for 20 seconds'), say('if nobody answers …')],
    builds: 'Transfer ring time / no-answer exit',
  },
  {
    get: 'Voicemail',
    phrases: [say('send them to voicemail'), say('let them leave a message in the Front desk mailbox')],
    builds: 'Voicemail',
  },
  {
    get: 'Going back',
    phrases: [say('go back to the main menu'), say('start over'), say('return to the greeting')],
    builds: 'Go to',
  },
  {
    get: 'Ending',
    phrases: [say('hang up'), say('say goodbye and hang up'), say('end the call')],
    builds: 'Hang up',
  },
];

/** The limits the guide states (§6). */
export const GUIDE_LIMITS: readonly string[] = [
  'US numbers only (no Canada, Caribbean, 900/976 or 555-01xx)',
  'Up to 12 menu keys',
  'A message is up to 1000 characters',
  'The assistant never publishes — you do',
];

/** The example requests (§6), click to use. */
export const GUIDE_EXAMPLES: readonly string[] = [
  'Greet callers, then: press 1 for billing, press 2 to report an outage, press 0 for the front desk. If nobody presses anything, repeat the menu once, then send them to voicemail.',
  'Weekdays 8am to 5pm Eastern, ring the front desk for 25 seconds and go to voicemail if nobody answers. After hours and on weekends, play our after-hours message and send them to voicemail.',
  "If the caller is blocked or private, say we don't accept anonymous calls and hang up. Otherwise go to the main menu.",
];

/** Shown above the message box (§6), verbatim. */
export const DISCLOSURE =
  'The assistant drafts a flow from your description. Your description and the names of your numbers and messages are processed by an AI service; phone numbers are replaced with placeholders first. Nothing changes until you accept, and nothing goes live until you publish.';

/** "Customers can write freely; these are the words the assistant understands best." */
export const GUIDE_INTRO = 'Write freely — these are the words the assistant understands best.';
