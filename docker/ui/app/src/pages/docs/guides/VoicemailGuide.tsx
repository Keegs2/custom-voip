/**
 * Visual Voicemail guide, for customers (tenant `user` / `readonly`).
 *
 * Labels are the app's own: pages/voicemail/VoicemailWorkspace.tsx (tabs,
 * mailbox bar), InboxView / ReadingPane / Player (folders, actions, speeds),
 * GreetingsPanel / GreetingDialog / AudioCapturePanel, MailboxSettings
 * (Details, Transcription, PIN, Storage) and TranscriptPanel. Rules and
 * numbers: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §4 (readonly = play +
 * download; mailboxes are created by Granite), §4.7 (Trash 30 days), §6
 * (caller flow: greeting, beep, `#`, 10 s silence), migration 54 defaults
 * (90 days, 5 minutes, 100 messages) and docs/VOICEMAIL_TRANSCRIPTION_PLAN.md
 * §0.1 (transcription off by default, switched on by Granite only).
 *
 * No prices, no vendor or key names: the in-app Transcription card carries
 * the full processing disclosure; this guide points to it.
 */
import {
  Bookmark, FileText, Gauge, KeyRound, Mic, PhoneIncoming, PlayCircle, Settings2, Shuffle,
} from 'lucide-react';
import { Bullets, Note, Para, Path, ProductGuide, Steps, Ui } from './GuideKit';
import type { ProductGuideContent } from './guideTopics';

const ICON = { size: 15, strokeWidth: 2 } as const;

const CONTENT: ProductGuideContent = {
  topic: 'voicemail',
  intro: 'Each mailbox has its own phone number. Listen, keep and manage its messages from any browser.',
  tasks: [
    {
      id: 'callers',
      title: 'What callers hear',
      summary: 'Your greeting, a beep, then time to leave a message.',
      icon: <PhoneIncoming {...ICON} />,
      body: (
        <>
          <Para>
            Callers who dial a mailbox’s number hear your greeting, then a beep, and can leave a message. A message ends
            when the caller hangs up, presses <Ui>#</Ui>, stops talking for about 10 seconds, or reaches the mailbox’s
            longest message (5 minutes unless your <Ui>Storage</Ui> row says otherwise). Pressing <Ui>#</Ui> during the
            greeting skips straight to the beep.
          </Para>
          <Para>Other ways to send calls to a mailbox:</Para>
          <Bullets>
            <>
              Set an RCF number’s <Ui>Forwarding destination</Ui> to the mailbox’s number. Every call to it goes straight
              to voicemail.
            </>
            <>
              In an IVR flow, use a <Ui>Voicemail</Ui> block, for example after a <Ui>Transfer</Ui> nobody answers.
            </>
          </Bullets>
          <Note>
            When a mailbox is full, callers hear that it’s full and can’t leave a message. See “Check storage and how long
            messages are kept”.
          </Note>
        </>
      ),
    },
    {
      id: 'listen',
      title: 'Listen to a message',
      summary: 'Play it at 1×, 1.5× or 2×, or download a copy.',
      icon: <PlayCircle {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              Open <Path items={['Products', 'Visual Voicemail']} />. If you have more than one mailbox, choose it under{' '}
              <Ui>Mailbox</Ui>.
            </>
            <>
              On the <Ui>Messages</Ui> tab, select a message in <Ui>Inbox</Ui>. New messages are marked <Ui>New</Ui>.
            </>
            <>
              Select play. Drag along the timeline to skip ahead, and pick <Ui>1×</Ui>, <Ui>1.5×</Ui> or <Ui>2×</Ui> to
              change the speed.
            </>
          </Steps>
          <Para>
            Playing a message marks it as played; <Ui>Mark unread</Ui> marks it new again. <Ui>Download</Ui> saves a copy
            as a WAV file. Times are shown in the mailbox’s timezone.
          </Para>
        </>
      ),
    },
    {
      id: 'organize',
      title: 'Save, delete or restore messages',
      summary: 'Inbox, Saved and Trash. Trash empties itself after 30 days.',
      icon: <Bookmark {...ICON} />,
      body: (
        <>
          <Bullets>
            <>
              <Ui>Save</Ui> moves a message to <Ui>Saved</Ui>; <Ui>Move to Inbox</Ui> moves it back.
            </>
            <>
              <Ui>Delete</Ui> moves it to <Ui>Trash</Ui>. Select <Ui>Undo</Ui> on the notice that appears if that was a
              mistake.
            </>
            <>
              In <Ui>Trash</Ui>, <Ui>Restore</Ui> puts a message back where it was. <Ui>Delete forever</Ui> erases it for
              good after you confirm.
            </>
          </Bullets>
          <Para>
            Trash is emptied automatically after 30 days. Saving a message doesn’t keep it past the mailbox’s retention
            period, so download anything you need to keep.
          </Para>
        </>
      ),
    },
    {
      id: 'greeting-add',
      title: 'Record or upload a greeting',
      summary: 'Record in your browser or upload an audio file, up to 2 minutes.',
      icon: <Mic {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              Open the <Ui>Greeting &amp; settings</Ui> tab and select <Ui>Add a greeting</Ui>.
            </>
            <>
              Choose <Ui>Record</Ui> and select <Ui>Start recording</Ui> (your browser asks to use the microphone; select{' '}
              <Ui>Stop</Ui> when you’re done), or choose <Ui>Upload a file</Ui>. WAV, MP3, M4A and most other audio
              formats work.
            </>
            <>
              Listen to the preview. Use <Ui>Record again</Ui> or <Ui>Choose a different file</Ui> to try again.
            </>
            <>
              Give it a <Ui>Name</Ui>, leave <Ui>Use this greeting now</Ui> ticked to switch to it straight away, then
              select <Ui>Save greeting</Ui>.
            </>
          </Steps>
          <Para>Greetings can be up to 2 minutes long; recording stops by itself at 2:00.</Para>
        </>
      ),
    },
    {
      id: 'greeting-switch',
      title: 'Choose which greeting callers hear',
      summary: 'The standard greeting, or one of your own.',
      icon: <Shuffle {...ICON} />,
      body: (
        <>
          <Bullets>
            <>
              <Ui>Standard greeting</Ui>: a short prompt asks the caller to leave a message after the tone.
            </>
            <>
              <Ui>Custom greeting</Ui>: plays your greeting marked <Ui>Active</Ui>. Select <Ui>Use this</Ui> on another
              greeting to make it the active one.
            </>
          </Bullets>
          <Para>
            To remove a greeting, select its delete button and confirm. If you delete the active one, callers hear the
            standard greeting.
          </Para>
        </>
      ),
    },
    {
      id: 'details',
      title: 'Set the mailbox name and timezone',
      summary: 'The name you see, and the timezone messages are shown in.',
      icon: <Settings2 {...ICON} />,
      body: (
        <Steps>
          <>
            On <Ui>Greeting &amp; settings</Ui>, find <Ui>Details</Ui>.
          </>
          <>
            Change the <Ui>Name</Ui> or <Ui>Timezone</Ui>.
          </>
          <>
            Select <Ui>Save</Ui>.
          </>
        </Steps>
      ),
    },
    {
      id: 'pin',
      title: 'Set a PIN',
      summary: 'Kept for phone access to the mailbox, which is coming later.',
      icon: <KeyRound {...ICON} />,
      body: (
        <>
          <Steps>
            <>
              On <Ui>Greeting &amp; settings</Ui>, open the <Ui>PIN</Ui> row.
            </>
            <>
              Type a PIN of 4 to 10 digits in <Ui>PIN</Ui> (or <Ui>New PIN</Ui>) and again in <Ui>Confirm</Ui>.
            </>
            <>
              Select <Ui>Set PIN</Ui> or <Ui>Change PIN</Ui>.
            </>
          </Steps>
          <Para>You don’t need a PIN to use Visual Voicemail in your browser.</Para>
        </>
      ),
    },
    {
      id: 'transcripts',
      title: 'Read a transcript',
      summary: 'Optional written transcripts, switched on by Granite.',
      icon: <FileText {...ICON} />,
      body: (
        <>
          <Para>
            Transcription is off for every mailbox to start with. Only Granite can turn it on; ask your account team. When
            it’s on, <Ui>Greeting &amp; settings</Ui> shows <Ui>Transcription</Ui> as <Ui>On</Ui> with its language, and
            new messages get a transcript:
          </Para>
          <Bullets>
            <>The first words show under each message in the list.</>
            <>
              The full text is under the player, in <Ui>Transcript</Ui>. Select <Ui>Show full transcript</Ui> for long
              messages, or <Ui>Copy</Ui> to copy it.
            </>
            <>
              Transcripts are machine-generated and may contain mistakes. <Ui>Low confidence</Ui> means it’s worth
              listening to the recording.
            </>
          </Bullets>
          <Para>
            If a transcript fails, select <Ui>Try again</Ui>. Messages that arrived while transcription was off can be sent
            with <Ui>Transcribe</Ui>. Messages in Trash aren’t transcribed, and a transcript is deleted together with its
            message. The <Ui>Transcription</Ui> card explains how transcripts are made and handled.
          </Para>
        </>
      ),
    },
    {
      id: 'storage',
      title: 'Check storage and how long messages are kept',
      summary: 'Message count, space used and the retention period.',
      icon: <Gauge {...ICON} />,
      body: (
        <>
          <Para>
            On <Ui>Greeting &amp; settings</Ui>, the <Ui>Storage</Ui> row shows how many messages the mailbox holds and
            how much space they use (<Ui>Space (includes Trash)</Ui>), plus <Ui>Messages are kept for</Ui> and{' '}
            <Ui>Longest message</Ui>.
          </Para>
          <Bullets>
            <>Unless Granite has set different limits, a mailbox holds 100 messages and keeps each one for 90 days.</>
            <>Each message shows the date it will be deleted. Messages are deleted automatically on that date.</>
            <>
              When the mailbox is <Ui>Full</Ui>, callers can’t leave new messages. Delete messages, then empty them from
              Trash with <Ui>Delete forever</Ui>, since Trash still uses space.
            </>
          </Bullets>
        </>
      ),
    },
  ],
  facts: [
    {
      label: 'Where',
      value: (
        <>
          <Path items={['Products', 'Visual Voicemail']} />
        </>
      ),
    },
    { label: 'Set up by', value: 'Granite: one phone number per mailbox' },
    { label: 'Kept for', value: '90 days by default; Trash 30 days' },
    { label: 'Security', value: 'Encrypted at rest' },
    { label: 'Read-only', value: 'Can listen and download only' },
  ],
  faq: [
    {
      id: 'not-in-sidebar',
      question: 'Visual Voicemail isn’t under Products',
      answer: (
        <Para>
          It’s turned on per account. Until then it’s listed under <Ui>Coming Soon</Ui>. Ask your Granite account team to
          add it.
        </Para>
      ),
    },
    {
      id: 'alerts',
      question: 'Do I get an email when a message arrives?',
      answer: (
        <Para>
          No. New messages appear in the Inbox when you open or refresh it, and the sidebar shows how many are unread.
        </Para>
      ),
    },
    {
      id: 'no-answer',
      question: 'Can unanswered forwarded calls go to voicemail?',
      answer: (
        <Para>
          Not automatically. An RCF number can send every call straight to a mailbox (set its{' '}
          <Ui>Forwarding destination</Ui> to the mailbox’s number). With IVR, a <Ui>Transfer</Ui> block’s{' '}
          <Ui>No answer or busy</Ui> route can lead to a <Ui>Voicemail</Ui> block.
        </Para>
      ),
    },
    {
      id: 'full',
      question: 'Callers say the mailbox is full',
      answer: (
        <Para>
          Delete messages you don’t need, then remove them from Trash with <Ui>Delete forever</Ui>. Trash still counts
          toward the mailbox’s space.
        </Para>
      ),
    },
    {
      id: 'by-phone',
      question: 'Can I check messages by phone?',
      answer: <Para>Not yet. Use Visual Voicemail in any browser. The PIN is kept for phone access later.</Para>,
    },
    {
      id: 'microphone',
      question: 'Recording a greeting doesn’t start',
      answer: (
        <Para>
          Allow microphone access when your browser asks, or in its site settings. You can also record somewhere else and
          use <Ui>Upload a file</Ui>.
        </Para>
      ),
    },
    {
      id: 'transcription-on',
      question: 'How do I turn transcription on?',
      answer: <Para>Only Granite can. Ask your account team.</Para>,
    },
  ],
};

export function VoicemailGuide() {
  return <ProductGuide content={CONTENT} />;
}
