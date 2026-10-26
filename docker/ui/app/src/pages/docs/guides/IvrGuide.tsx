/**
 * IVR guide, for customers (tenant `user` / `readonly`).
 *
 * What a customer really does today (docs/IVR_INTERFACES.md §8.2, docker/ui
 * CLAUDE.md §19): Granite turns IVR on for the account and assigns its IVR
 * numbers; the customer's `user` role builds, tests and publishes flows,
 * makes messages and picks the flow each number answers with. `readonly`
 * views only. Labels are the app's own: pages/ivr/IvrHome.tsx, IvrDialogs,
 * prompts/PromptDialog, flow/model/blocks.ts (block names), flow/config/
 * BlockForms + TransferPicker, flow/panels/{Simulator,Publish,History}Panel.
 * Limits: §2 (menu wait 1–30 s, ring 5–120 s), §4 (messages ≤ 2 min,
 * typed text ≤ 1,000 characters), §6 (US-only outside numbers), summary
 * limits (100 flows).
 *
 * Not documented: the Flow assistant (off unless separately enabled per
 * account) and anything staff-only (TED entitlement, number switch-off).
 */
import {
  CalendarClock, FlaskConical, Grid3x3, History, ListTree, MessageSquareText, PhoneForwarded, Rocket, Workflow,
} from 'lucide-react';
import { Bullets, Note, Para, Path, ProductGuide, Steps, Terms, Ui } from './GuideKit';
import type { ProductGuideContent } from './guideTopics';

const ICON = { size: 15, strokeWidth: 2 } as const;

const BLOCKS: readonly { term: string; text: string }[] = [
  { term: 'Start', text: 'Where every call begins.' },
  { term: 'Play message', text: 'Play one or more recordings or read text aloud.' },
  { term: 'Menu', text: 'Ask the caller to press a key, then branch on it.' },
  { term: 'Business hours', text: 'Route differently when you are open or closed.' },
  { term: 'Caller check', text: 'Branch on the caller’s number.' },
  { term: 'Transfer', text: 'Ring one of your numbers or an outside US number.' },
  { term: 'Voicemail', text: 'Let the caller leave a message in one of your mailboxes.' },
  { term: 'Go to', text: 'Jump back to another block, such as “repeat the menu”.' },
  { term: 'Hang up', text: 'Optionally say goodbye, then end the call.' },
];

const CONTENT: ProductGuideContent = {
  topic: 'ivr',
  intro: 'Design what callers hear when they dial your IVR numbers, test it, then publish it.',
  tasks: [
    {
      id: 'how-it-works',
      title: 'How IVR works',
      summary: 'Each IVR number answers with one flow you design.',
      icon: <Workflow {...ICON} />,
      body: (
        <>
          <Para>
            A flow is the menu and routing you draw on a canvas. Each IVR number answers with one flow, and callers hear
            its published version. Your edits save automatically as a draft and stay out of callers’ way until you
            publish. Flows are built from these blocks:
          </Para>
          <Terms items={BLOCKS} />
        </>
      ),
    },
    {
      id: 'messages',
      title: 'Create a message',
      summary: 'Type text to be read aloud, record your voice or upload audio.',
      icon: <MessageSquareText {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              On the IVR page, under <Ui>Messages</Ui>, select <Ui>New message</Ui>.
            </>
            <>
              Choose how to make it:
              <Bullets>
                <>
                  <Ui>Type text</Ui>: write <Ui>What callers hear</Ui> (up to 1,000 characters), pick a <Ui>Voice</Ui>{' '}
                  and select <Ui>Preview</Ui> to listen.
                </>
                <>
                  <Ui>Record</Ui>: record in your browser.
                </>
                <>
                  <Ui>Upload a file</Ui>: use an audio file you already have.
                </>
              </Bullets>
            </>
            <>
              Name it and select <Ui>Save message</Ui>.
            </>
          </Steps>
          <Para>
            Messages can be up to 2 minutes long. Use them in <Ui>Play message</Ui>, <Ui>Menu</Ui> and <Ui>Hang up</Ui>{' '}
            blocks. You can also create one from inside a block while you build.
          </Para>
        </>
      ),
    },
    {
      id: 'build',
      title: 'Build a flow',
      summary: 'Add blocks to the canvas and connect each exit.',
      icon: <ListTree {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              Under <Ui>Flows</Ui>, select <Ui>New flow</Ui>, give it a name and select <Ui>Create and open</Ui>.
            </>
            <>
              Drag a block from <Ui>Blocks</Ui> onto the canvas, or click one to add it after the selected block.
            </>
            <>
              Select a block to set it up in the panel on the right.
            </>
            <>
              Connect every exit: drag from an exit’s dot to the next block, or use <Ui>Where each choice goes</Ui>.{' '}
              <Ui>Nothing — the call ends</Ui> is also a choice.
            </>
          </Steps>
          <Para>
            Undo, redo and <Ui>Tidy up the layout</Ui> are in the top bar. The <Ui>Outline</Ui> tab lists every block in
            calling order. To repeat a menu, add a <Ui>Go to</Ui> block that points back to it.
          </Para>
        </>
      ),
    },
    {
      id: 'menu',
      title: 'Set up a menu',
      summary: 'Let callers press a key, with another try if they don’t.',
      icon: <Grid3x3 {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              Add a <Ui>Menu</Ui> block and choose its <Ui>Menu message</Ui>.
            </>
            <>Pick the keys callers can press. Each key gets its own exit.</>
            <>
              Set <Ui>Wait for a key</Ui> (1 to 30 seconds) and what happens <Ui>If no key or a wrong key</Ui>, from{' '}
              <Ui>Don’t ask again</Ui> to <Ui>Ask 5 more times</Ui>.
            </>
            <>
              Connect each <Ui>Press</Ui> exit, plus <Ui>No key pressed</Ui> and <Ui>Wrong key</Ui>.
            </>
          </Steps>
          <Para>
            Callers can press a key while the menu is still playing. You can add an optional <Ui>Wrong-key message</Ui> and{' '}
            <Ui>No-key message</Ui>.
          </Para>
        </>
      ),
    },
    {
      id: 'hours',
      title: 'Route by business hours',
      summary: 'Send calls one way when you’re open and another when you’re closed.',
      icon: <CalendarClock {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              Add a <Ui>Business hours</Ui> block and choose its <Ui>Time zone</Ui>.
            </>
            <>Set the opening hours for each day. A day can have more than one range.</>
            <>
              Add holidays under <Ui>Closed all day on</Ui>.
            </>
            <>
              Connect the <Ui>Open</Ui> and <Ui>Closed</Ui> exits.
            </>
          </Steps>
          <Para>
            To route by who is calling instead, use <Ui>Caller check</Ui>: match numbers that start with something (an area
            code such as 617), exact numbers, or callers who withheld their number.
          </Para>
        </>
      ),
    },
    {
      id: 'transfer',
      title: 'Transfer callers',
      summary: 'Ring one of your numbers or any US number.',
      icon: <PhoneForwarded {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              Add a <Ui>Transfer</Ui> block and choose where it rings: one of your numbers (call forwarding, voicemail,
              other IVRs or SIP trunk) or an outside number.
            </>
            <>
              Under <Ui>Whoever answers sees</Ui>, choose <Ui>The caller’s number</Ui> or <Ui>This IVR’s number</Ui>.
            </>
            <>Set how long it rings: 5 to 120 seconds.</>
            <>
              Connect <Ui>No answer or busy</Ui>, for example to a <Ui>Voicemail</Ui> block.
            </>
          </Steps>
          <Note>
            Outside numbers must be in the US, including toll-free numbers. Canada and other countries can’t be dialed.
          </Note>
        </>
      ),
    },
    {
      id: 'test',
      title: 'Try a test call',
      summary: 'Walk a pretend call through your draft. Nothing is dialed.',
      icon: <FlaskConical {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              In the flow, select <Ui>Test call</Ui>.
            </>
            <>Choose the caller (a number, or withheld), when the call happens and which keys get pressed.</>
            <>
              Select <Ui>Start test call</Ui>. The steps play one at a time and the canvas follows along.
            </>
          </Steps>
          <Para>
            The test uses your current draft, so you can try changes before you publish. Select <Ui>Run again</Ui> to
            repeat it.
          </Para>
        </>
      ),
    },
    {
      id: 'publish',
      title: 'Publish and put a flow live',
      summary: 'Publish a version, then choose it for your IVR number.',
      icon: <Rocket {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              In the flow, select <Ui>Publish</Ui>. Granite checks the flow and lists anything to fix; select a problem to
              jump to its block.
            </>
            <>
              Review what changed and what callers will hear, then select <Ui>Publish version</Ui>.
            </>
            <>
              Back on the IVR page, under <Ui>Your IVR numbers</Ui>, select <Ui>Choose a flow</Ui> (or{' '}
              <Ui>Change flow</Ui>) for the number, pick the flow and select <Ui>Use this flow</Ui>.
            </>
          </Steps>
          <Para>
            The number then reads <Ui>Live</Ui> with the version number. A number keeps answering with its flow, so later
            versions you publish go live on it straight away.
          </Para>
        </>
      ),
    },
    {
      id: 'history',
      title: 'Go back to an earlier version',
      summary: 'Every published version is kept.',
      icon: <History {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              In the flow, select <Ui>History</Ui>.
            </>
            <>
              Select <Ui>View</Ui> to look at a version, then <Ui>Back to your draft</Ui>.
            </>
            <>
              To start again from an old version, select <Ui>Restore to draft</Ui> and confirm.
            </>
          </Steps>
          <Para>Restoring changes your draft only. Publish it to make it live.</Para>
        </>
      ),
    },
  ],
  facts: [
    {
      label: 'Where',
      value: (
        <>
          <Path items={['Products', 'IVR']} />, once it’s on for your account
        </>
      ),
    },
    { label: 'Set up by', value: 'Granite turns it on and assigns numbers' },
    { label: 'You build', value: 'Flows and messages, then test and publish' },
    { label: 'Each number', value: 'Answers with one flow, in its published version' },
    { label: 'Limits', value: 'Up to 100 flows; messages up to 2 minutes' },
    { label: 'Read-only', value: 'Can look, but not edit or publish' },
  ],
  faq: [
    {
      id: 'not-in-sidebar',
      question: 'IVR isn’t under Products',
      answer: (
        <Para>
          IVR is turned on per account. Until then it’s under <Ui>Coming Soon</Ui>, and its page explains what it does.
          Ask your Granite account team to add it.
        </Para>
      ),
    },
    {
      id: 'status',
      question: 'What does my number’s status mean?',
      answer: (
        <Bullets>
          <>
            <Ui>Live</Ui>: callers hear the published flow.
          </>
          <>
            <Ui>No flow — calls turned away</Ui>: select <Ui>Choose a flow</Ui>.
          </>
          <>
            <Ui>Not published yet</Ui>: open the flow and publish it.
          </>
          <>
            <Ui>Switched off</Ui>: Granite has switched the number off. Contact your account team.
          </>
        </Bullets>
      ),
    },
    {
      id: 'no-number',
      question: 'I don’t have an IVR number yet',
      answer: (
        <Para>
          You can still build and test flows. Ask your Granite account team for an IVR number, then choose the flow it
          answers with.
        </Para>
      ),
    },
    {
      id: 'in-progress',
      question: 'Do callers already in the menu hear my new version?',
      answer: <Para>No. Calls in progress keep the version they started with. The next call hears the new one.</Para>,
    },
    {
      id: 'cant-delete',
      question: 'Why can’t I delete a message or a flow?',
      answer: (
        <Para>
          A message can’t be deleted while a flow’s draft uses it; the warning names the flows. A flow can’t be deleted
          while a number answers with it, so choose another flow for that number first.
        </Para>
      ),
    },
    {
      id: 'phone',
      question: 'Can I edit a flow on my phone?',
      answer: (
        <Para>
          On a small screen the flow is shown read-only, as a diagram and an outline. Edit it on a larger screen.
        </Para>
      ),
    },
  ],
};

export function IvrGuide() {
  return <ProductGuide content={CONTENT} />;
}
