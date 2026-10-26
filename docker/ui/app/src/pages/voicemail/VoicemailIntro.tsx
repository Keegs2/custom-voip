/**
 * VoicemailIntro — what a tenant sees when Visual Voicemail isn't switched
 * on for their account. Copy is trimmed to what ships (build plan D3/D5/D7):
 * web inbox, greetings, encryption at rest, retention (per mailbox
 * `retention_days`, 90 by default — no mailbox exists yet here). Transcription
 * (v1.1) is mentioned only while it is live on the platform
 * (`summary.transcription_available`), and as optional — it is off per
 * mailbox until Granite turns it on (owner decisions O1/O2). No search, no
 * notifications, no voicemail API, no prices.
 */
import { Download, FileText, Lock, Mic, PlayCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconVoicemail } from '../../components/icons/ProductIcons';

interface Point {
  icon: ReactNode;
  title: string;
  line: string;
  /** Shown only while transcription is available. */
  transcription?: boolean;
}

const POINTS: readonly Point[] = [
  {
    icon: <PlayCircle size={17} strokeWidth={1.8} />,
    title: 'Listen in your browser',
    line: 'Every message in an inbox you can scan, play and skip through — no dial-in menus.',
  },
  {
    icon: <FileText size={17} strokeWidth={1.8} />,
    title: 'Read it instead',
    line: 'Optional transcripts appear next to each message.',
    transcription: true,
  },
  {
    icon: <Mic size={17} strokeWidth={1.8} />,
    title: 'Your own greeting',
    line: 'Record one right here or upload an audio file, and switch between greetings any time.',
  },
  {
    icon: <Download size={17} strokeWidth={1.8} />,
    title: 'Save or download',
    line: 'Keep the messages that matter in Saved, or download a copy as a WAV file.',
  },
  {
    icon: <Lock size={17} strokeWidth={1.8} />,
    title: 'Encrypted at rest',
    line: 'Messages are encrypted with a key that belongs only to your account, and deleted automatically when the mailbox’s retention period ends (90 days by default).',
  },
];

export interface VoicemailIntroProps {
  /** summary.transcription_available. */
  transcriptionAvailable?: boolean;
}

export function VoicemailIntro({ transcriptionAvailable = false }: VoicemailIntroProps) {
  const points = POINTS.filter((p) => !p.transcription || transcriptionAvailable);
  return (
    <div className="dl-panel vm-intro">
      <div className="vm-intro-head">
        <span className="dl-center-icon" aria-hidden="true">
          <IconVoicemail size={26} />
        </span>
        <div>
          <h2 className="vm-intro-title">Visual Voicemail isn’t on your account yet</h2>
          <p className="vm-intro-copy">
            Give a number its own voicemail and pick up the messages here, from any browser.
          </p>
        </div>
      </div>
      <ul className="vm-intro-points">
        {points.map((p) => (
          <li key={p.title} className="vm-intro-point">
            <span className="vm-intro-chip" aria-hidden="true">
              {p.icon}
            </span>
            <span>
              <strong>{p.title}</strong>
              <span>{p.line}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="vm-intro-close">Ask your Granite account team to set up a voicemail number.</p>
    </div>
  );
}
