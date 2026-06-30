/**
 * Local types + constants for the Visual Voicemail feature folder.
 *
 * Page-global voicemail shapes (VoicemailMailbox / VoicemailMessage / Transcript)
 * come from `src/types/voicemail.ts`. Only the inbox-UI-local union lives here.
 */

import type { MailboxMessagesParams } from '../../api/voicemail';

/** The four inbox folders the rail exposes. */
export type Folder = 'inbox' | 'unread' | 'saved' | 'trash';

/**
 * Map each UI folder to a single server query (no client-side diffing).
 * The backend `folder` param does the filtering: inbox = not-deleted & not-saved,
 * saved = saved & not-deleted, trash = soft-deleted. Unread reuses the inbox
 * folder narrowed by `is_read=false`.
 */
export const FOLDER_QUERY: Record<Folder, Pick<MailboxMessagesParams, 'folder' | 'is_read'>> = {
  inbox: { folder: 'inbox' },
  unread: { folder: 'inbox', is_read: false },
  saved: { folder: 'saved' },
  trash: { folder: 'trash' },
};
