/**
 * RCF guide — call forwarding, for customers (tenant `user` / `readonly`).
 *
 * Every label below is the app's own: pages/rcf/CustomerNumbersPage.tsx,
 * RoutingBoard.tsx, RowEditor.tsx (the number's settings), DidManagement.tsx
 * (Request and manage numbers) and the dashboard's quick actions. Limits are
 * the API's (routers/rcf.py: ring timeout 5–120 s; new numbers start at 30).
 *
 * Deliberately NOT documented: the editor's "Failover destination" (stored
 * but not used for routing today) and "Max concurrent calls" beyond "set by
 * Granite". See docker/ui/CLAUDE.md §7 "Guides".
 */
import {
  Activity, IdCard, PauseCircle, PhoneForwarded, PlusCircle, Search, Tag, Timer, Undo2,
} from 'lucide-react';
import { Bullets, Note, Para, Path, ProductGuide, Steps, Ui } from './GuideKit';
import type { ProductGuideContent } from './guideTopics';

const ICON = { size: 15, strokeWidth: 2 } as const;

const CONTENT: ProductGuideContent = {
  topic: 'rcf',
  intro: 'Each call forwarding number rings the destination you choose. Select a task to see the steps.',
  tasks: [
    {
      id: 'find-numbers',
      title: 'Find your numbers',
      summary: 'Every number, where it rings and whether it’s on.',
      icon: <Search {...ICON} />,
      body: (
        <>
          <Para>
            In the sidebar, open <Path items={['Products', 'RCF']} />. The <Ui>Call forwarding numbers</Ui> page lists
            each number with its label, where it <Ui>Forwards to</Ui> and its <Ui>Status</Ui>.
          </Para>
          <Bullets>
            <>Type in the search box to find a number, label or destination.</>
            <>
              Pick <Ui>All</Ui>, <Ui>Forwarding</Ui> or <Ui>Paused</Ui> to filter the list.
            </>
            <>
              Use <Ui>Sort by</Ui> to order it, for example by <Ui>Most calls this week</Ui>.
            </>
          </Bullets>
          <Note>
            Your numbers are also on the <Ui>Dashboard</Ui>, in <Ui>Your numbers</Ui>. Selecting one there opens the same
            settings.
          </Note>
        </>
      ),
    },
    {
      id: 'change-destination',
      title: 'Change where a number rings',
      summary: 'Type a new destination and save. The next call rings there.',
      icon: <PhoneForwarded {...ICON} />,
      body: (
        <>
          <Steps>
            <>Select the number to open its settings.</>
            <>
              In <Ui>Forwarding destination</Ui>, type the number to ring. A 10-digit US number is fine: spaces, dashes and
              brackets are tidied up for you.
            </>
            <>
              Select <Ui>Save changes</Ui>, or press Enter.
            </>
          </Steps>
          <Para>
            The next call to that number rings the new destination. Calls already in progress aren’t affected.{' '}
            <Ui>Cancel</Ui> throws away edits you haven’t saved.
          </Para>
        </>
      ),
    },
    {
      id: 'ring-timeout',
      title: 'Set how long a call rings',
      summary: 'Anywhere from 5 to 120 seconds before the call stops ringing.',
      icon: <Timer {...ICON} />,
      body: (
        <>
          <Steps>
            <>Open the number’s settings.</>
            <>
              In <Ui>Ring timeout</Ui>, enter the number of seconds, from 5 to 120.
            </>
            <>
              Select <Ui>Save changes</Ui>.
            </>
          </Steps>
          <Para>
            New numbers start at 30 seconds. When the time runs out, the call stops ringing and the caller hears that
            nobody answered. The exact tone or message depends on the caller’s phone service.
          </Para>
        </>
      ),
    },
    {
      id: 'caller-id',
      title: 'Choose the caller ID the answerer sees',
      summary: 'Show the original caller’s number, or your own number.',
      icon: <IdCard {...ICON} />,
      body: (
        <>
          <Para>
            Open the number’s settings and flip the <Ui>Caller ID</Ui> switch. The change is saved as soon as you flip it.
          </Para>
          <Bullets>
            <>
              <Ui>Caller ID: pass-through</Ui>: the person answering sees the original caller’s number.
            </>
            <>
              <Ui>Caller ID: show this DID</Ui>: they see your number on every call, so they can tell it came through your
              line.
            </>
          </Bullets>
        </>
      ),
    },
    {
      id: 'pause',
      title: 'Pause or resume a number',
      summary: 'Stop forwarding for a while without losing its settings.',
      icon: <PauseCircle {...ICON} />,
      body: (
        <>
          <Para>
            Open the number’s settings and flip the forwarding switch. Like caller ID, it’s saved right away.
          </Para>
          <Bullets>
            <>
              <Ui>Forwarding disabled</Ui>: calls to the number are turned away. The number shows as <Ui>Paused</Ui> in
              your list, and its other settings are kept.
            </>
            <>
              <Ui>Forwarding enabled</Ui>: forwarding starts again with the next call.
            </>
          </Bullets>
        </>
      ),
    },
    {
      id: 'label',
      title: 'Name a number',
      summary: 'Give a line a label such as “Boston office”.',
      icon: <Tag {...ICON} />,
      body: (
        <>
          <Steps>
            <>Open the number’s settings.</>
            <>
              Type a name in <Ui>Label</Ui>.
            </>
            <>
              Select <Ui>Save changes</Ui>.
            </>
          </Steps>
          <Para>
            Labels help you find a number in your list, on the Dashboard and in Reporting. They never change how calls are
            routed.
          </Para>
        </>
      ),
    },
    {
      id: 'request-number',
      title: 'Request a new number',
      summary: 'Pick one from the available numbers. Granite reviews and assigns it.',
      icon: <PlusCircle {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              On the RCF page or the Dashboard, select <Ui>Request numbers</Ui>.
            </>
            <>
              Under <Ui>Available Numbers</Ui>, narrow the list by city, rate center, area code, exchange or state.
            </>
            <>
              Select <Ui>Request</Ui> beside the number you want, then <Ui>Confirm Request</Ui>.
            </>
            <>
              The number waits under <Ui>Pending Requests</Ui> as <Ui>Pending Approval</Ui>. Once Granite approves it, it
              appears on your RCF page, already forwarding — check its forwarding destination and change it if needed.
            </>
          </Steps>
          <Note>
            Only users with the User role can request numbers. Read-only users can browse the list but don’t see{' '}
            <Ui>Request</Ui>.
          </Note>
        </>
      ),
    },
    {
      id: 'release-number',
      title: 'Release a number you no longer need',
      summary: 'Ask Granite to take a number back. It keeps working until approved.',
      icon: <Undo2 {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              Select <Ui>Request numbers</Ui> to open <Ui>Request and manage numbers</Ui>.
            </>
            <>
              Under <Ui>My Numbers</Ui>, select <Ui>Request Release</Ui> beside the number, then confirm with{' '}
              <Ui>Request Release</Ui>.
            </>
            <>
              The number shows <Ui>Release Requested</Ui> and keeps forwarding while Granite reviews the request.
            </>
          </Steps>
          <Para>
            Changed your mind? Select <Ui>Cancel Request</Ui> any time before it’s approved. Once Granite approves the
            release, the number leaves your account and forwarding stops.
          </Para>
        </>
      ),
    },
    {
      id: 'call-activity',
      title: 'See how your calls are going',
      summary: 'Call activity, call quality and downloadable reports.',
      icon: <Activity {...ICON} />,
      body: (
        <>
          <Para>
            On the <Ui>Dashboard</Ui>, select <Ui>Open call activity</Ui>. Choose <Ui>24h</Ui>, <Ui>7d</Ui>, <Ui>30d</Ui> or{' '}
            <Ui>90d</Ui>, and look at all your numbers or pick one. You’ll see:
          </Para>
          <Bullets>
            <>
              <Ui>Calls</Ui>, <Ui>Answer rate</Ui> and <Ui>Avg duration</Ui> (the average length of answered calls).
            </>
            <>
              <Ui>Sounded good or better</Ui>: the share of graded calls with good sound. Calls that weren’t answered,
              lasted under 5 seconds or carried too little sound aren’t graded.
            </>
            <>
              <Ui>One-way audio</Ui>: calls where sound came through from one side only.
            </>
          </Bullets>
          <Para>
            For any period, open <Path items={['Insights', 'Reporting']} /> and select{' '}
            <Ui>Spreadsheet (CSV)</Ui> or <Ui>PDF summary</Ui>.
          </Para>
        </>
      ),
    },
  ],
  facts: [
    {
      label: 'Where',
      value: (
        <>
          <Path items={['Products', 'RCF']} />, and the Dashboard
        </>
      ),
    },
    { label: 'You set', value: 'Destination, ring timeout, caller ID, on/off' },
    { label: 'Granite', value: 'Approves new numbers and releases' },
    { label: 'Changes', value: 'Apply from the next call' },
    { label: 'Read-only', value: 'Can see everything, but not change it' },
  ],
  faq: [
    {
      id: 'not-forwarding',
      question: 'Calls aren’t being forwarded',
      answer: (
        <Para>
          Open the number and check that it isn’t <Ui>Paused</Ui> and that the <Ui>Forwarding destination</Ui> is right.
          Then call the destination directly to make sure it can take calls.
        </Para>
      ),
    },
    {
      id: 'rings-out',
      question: 'Calls stop ringing before anyone answers',
      answer: (
        <Para>
          Raise the number’s <Ui>Ring timeout</Ui>. It can be up to 120 seconds.
        </Para>
      ),
    },
    {
      id: 'their-voicemail',
      question: 'Calls end up in the destination phone’s voicemail',
      answer: (
        <Para>
          That phone’s own voicemail picked up before your <Ui>Ring timeout</Ui> ran out. Set a shorter ring timeout if
          you’d rather the call stop ringing first.
        </Para>
      ),
    },
    {
      id: 'no-caller-id',
      question: 'The person answering can’t see who’s calling',
      answer: (
        <Para>
          Set the number’s caller ID to <Ui>Caller ID: pass-through</Ui>.
        </Para>
      ),
    },
    {
      id: 'to-voicemail',
      question: 'Can a number send calls to my voicemail or IVR?',
      answer: (
        <Para>
          Yes. Set its <Ui>Forwarding destination</Ui> to your mailbox’s or IVR’s number. Calls then go straight there
          instead of ringing a phone first.
        </Para>
      ),
    },
    {
      id: 'cant-edit',
      question: 'I can’t change anything, or there’s no Request button',
      answer: (
        <Para>
          Your sign-in is Read-only. Ask a colleague with the User role, or your Granite account team, to make the change.
        </Para>
      ),
    },
  ],
};

export function RcfGuide() {
  return <ProductGuide content={CONTENT} />;
}
