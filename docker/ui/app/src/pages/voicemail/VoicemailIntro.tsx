/**
 * VoicemailIntro — what a tenant sees when Visual Voicemail isn't switched
 * on for their account. Copy is trimmed to what v1 ships (build plan D3/D5/
 * D7): web inbox, greetings, encryption at rest, 90-day retention. No
 * transcription, notifications, API or prices.
 */
import { Download, Lock, Mic, PlayCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconVoicemail } from '../../components/icons/ProductIcons';

interface Point {
  icon: ReactNode;
  title: string;
  line: string;
}

const POINTS: readonly Point[] = [
  {
    icon: <PlayCircle size={17} strokeWidth={1.8} />,
    title: 'Listen in your browser',
    line: 'Every message in an inbox you can scan, play and skip through — no dial-in menus.',
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
    line: 'Messages are encrypted with a key that belongs only to your account, and deleted automatically after 90 days.',
  },
];

export function VoicemailIntro() {
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
        {POINTS.map((p) => (
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
