/**
 * Visual Voicemail. Source: routers/voicemail.py — every route below takes
 * `vm_scope` (tenant user/readonly, own customer, voicemail-enabled) or
 * `vm_writer` (readonly => 403). NOT documented: mailbox create/delete,
 * available-numbers, crypto-erase, backfill, transcription status/requeue
 * (all `vm_admin`) and the `/fs/*` routes. Contract:
 * docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §4 + §9.
 */
import { AUTH_HEADER, S401, S403_EDIT, S503, notFound, ok } from '../common';
import { READ_ROLES, WRITE_ROLES, type FieldDoc, type SectionDoc } from '../types';

const MAILBOX_FIELDS: readonly FieldDoc[] = [
  { name: 'id', type: 'integer', description: 'The mailbox’s id.' },
  { name: 'did', type: 'string', description: 'The mailbox’s number, E.164.' },
  { name: 'label', type: 'string', description: 'The mailbox’s name.' },
  {
    name: 'status',
    type: 'string',
    description: '`active`, or `suspended` (callers can’t leave messages; existing ones stay).',
  },
  { name: 'timezone', type: 'string', description: 'IANA time zone for the mailbox.' },
  { name: 'greeting_mode', type: 'string', description: '`standard` or `custom`.' },
  {
    name: 'active_greeting_id',
    type: 'integer',
    description: 'The greeting callers hear in `custom` mode, or `null`.',
  },
  { name: 'has_pin', type: 'boolean', description: 'Whether a PIN is set.' },
  { name: 'message_count', type: 'integer', description: 'Messages, not counting Trash.' },
  { name: 'unread_count', type: 'integer', description: 'Unread messages, not counting Trash.' },
  { name: 'max_messages', type: 'integer', description: 'Most messages the mailbox holds.' },
  { name: 'max_message_seconds', type: 'integer', description: 'Longest message a caller can leave, seconds.' },
  { name: 'bytes_used', type: 'integer', description: 'Storage used, including Trash.' },
  { name: 'max_bytes', type: 'integer', description: 'Storage limit.' },
  { name: 'retention_days', type: 'integer', description: 'Days a message is kept.' },
  {
    name: 'transcription_enabled',
    type: 'boolean',
    description: 'Whether new messages are transcribed. Set by Granite.',
  },
  { name: 'transcription_language', type: 'string', description: 'Transcription language, for example `en-US`.' },
  { name: 'created_at', type: 'string (date-time)', description: 'When the mailbox was created.' },
];

const MAILBOX_EXAMPLE =
  '{\n' +
  '  "id": 12,\n' +
  '  "did": "+16175550150",\n' +
  '  "label": "Front desk",\n' +
  '  "status": "active",\n' +
  '  "timezone": "America/New_York",\n' +
  '  "greeting_mode": "custom",\n' +
  '  "active_greeting_id": 31,\n' +
  '  "has_pin": true,\n' +
  '  "message_count": 5,\n' +
  '  "unread_count": 2,\n' +
  '  "max_messages": 100,\n' +
  '  "max_message_seconds": 300,\n' +
  '  "bytes_used": 1843200,\n' +
  '  "max_bytes": 524288000,\n' +
  '  "retention_days": 90,\n' +
  '  "transcription_enabled": true,\n' +
  '  "transcription_language": "en-US",\n' +
  '  "created_at": "2026-10-20T15:02:44+00:00"\n' +
  '}';

const MESSAGE_FIELDS: readonly FieldDoc[] = [
  { name: 'id', type: 'integer', description: 'The message’s id.' },
  { name: 'mailbox_id', type: 'integer', description: 'Its mailbox.' },
  { name: 'caller_id_number', type: 'string', description: 'The caller’s number, or `null`.' },
  { name: 'caller_id_name', type: 'string', description: 'The caller’s name, or `null`.' },
  { name: 'duration_ms', type: 'integer', description: 'Recording length, milliseconds.' },
  { name: 'size_bytes', type: 'integer', description: 'Recording size.' },
  { name: 'is_read', type: 'boolean', description: 'Played or marked read.' },
  { name: 'is_saved', type: 'boolean', description: 'In Saved.' },
  { name: 'deleted_at', type: 'string (date-time)', description: 'When it was moved to Trash; `null` otherwise.' },
  { name: 'created_at', type: 'string (date-time)', description: 'When it was left.' },
  { name: 'expires_at', type: 'string (date-time)', description: 'When it’s deleted automatically.' },
  {
    name: 'transcript.status',
    type: 'string',
    description: '`pending`, `processing`, `done`, `empty`, `failed` or `disabled`.',
  },
  { name: 'transcript.confidence', type: 'number', description: '0–1 when `done`; else `null`.' },
];

const MESSAGE_EXAMPLE =
  '{\n' +
  '  "id": 5012,\n' +
  '  "mailbox_id": 12,\n' +
  '  "caller_id_number": "+16175550190",\n' +
  '  "caller_id_name": "J SMITH",\n' +
  '  "duration_ms": 23400,\n' +
  '  "size_bytes": 374444,\n' +
  '  "is_read": false,\n' +
  '  "is_saved": false,\n' +
  '  "deleted_at": null,\n' +
  '  "created_at": "2026-10-22T14:11:05+00:00",\n' +
  '  "expires_at": "2027-01-20T14:11:05+00:00",\n' +
  '  "transcript": { "status": "done", "confidence": 0.93 }\n' +
  '}';

const TOKEN_FIELDS: readonly FieldDoc[] = [
  {
    name: 'url',
    type: 'string',
    description: 'A path on your portal host (`/api/v1/…/audio?t=…`) that serves the WAV audio.',
  },
  { name: 'expires_in', type: 'integer', description: 'Seconds the link works: `120`.' },
];

const at = (message: string) => message.replace(/^/gm, '    ');

export const VOICEMAIL: SectionDoc = {
  label: 'Visual Voicemail',
  intro:
    'Mailboxes, messages, transcripts and greetings. Voicemail is switched on per account — while it’s off, lists are empty and mailboxes answer 404.',
  groups: [
    {
      id: 'mailboxes',
      title: 'Mailboxes',
      intro: 'Granite creates and removes mailboxes; you manage their names, time zone, greeting and PIN.',
      entries: [
        {
          kind: 'endpoint',
          id: 'vm-summary',
          method: 'GET',
          path: '/voicemail/summary',
          title: 'Voicemail summary',
          summary: 'Whether voicemail is on for your account, and mailbox and unread counts.',
          roles: READ_ROLES,
          returns: 'One object.',
          fields: [
            { name: 'enabled', type: 'boolean', description: 'Whether Visual Voicemail is on for your account.' },
            { name: 'mailbox_count', type: 'integer', description: 'Your mailboxes.' },
            { name: 'unread_count', type: 'integer', description: 'Unread messages across them.' },
            {
              name: 'transcription_available',
              type: 'boolean',
              description: 'Whether transcription is offered right now (each mailbox is switched on by Granite).',
            },
          ],
          statuses: [ok(), S401],
          example: {
            request: `curl "$BASE/voicemail/summary" ${AUTH_HEADER}`,
            response:
              '{\n  "enabled": true,\n  "mailbox_count": 2,\n  "unread_count": 3,\n  "transcription_available": true\n}',
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-mailboxes',
          method: 'GET',
          path: '/voicemail/mailboxes',
          title: 'List mailboxes',
          summary: 'Your mailboxes with their settings, limits and counts.',
          roles: READ_ROLES,
          returns: 'An array of mailboxes, by name (not paged).',
          fields: MAILBOX_FIELDS.map((f) => ({ ...f, name: `[].${f.name}` })),
          statuses: [ok(), S401],
          example: {
            request: `curl "$BASE/voicemail/mailboxes" ${AUTH_HEADER}`,
            response: `[\n${MAILBOX_EXAMPLE.replace(/^/gm, '  ')}\n]`,
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-mailbox',
          method: 'GET',
          path: '/voicemail/mailboxes/{mailbox_id}',
          title: 'Get a mailbox',
          summary: 'One mailbox.',
          roles: READ_ROLES,
          params: [
            { name: 'mailbox_id', in: 'path', type: 'integer', required: true, description: 'The mailbox’s id.' },
          ],
          returns: 'One mailbox (the list fields).',
          statuses: [ok(), S401, notFound('The mailbox')],
          example: {
            request: `curl "$BASE/voicemail/mailboxes/12" ${AUTH_HEADER}`,
            response: MAILBOX_EXAMPLE,
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-mailbox-update',
          method: 'PATCH',
          path: '/voicemail/mailboxes/{mailbox_id}',
          title: 'Change a mailbox',
          summary: 'Rename it, set its time zone, or choose its greeting.',
          description: [
            'Send only what you want to change. To switch to a custom greeting, send `greeting_mode: "custom"` with an `active_greeting_id` (or after one is set). Switching back to `standard` keeps the chosen greeting for later.',
            'Suspending a mailbox and the transcription settings are changed by Granite.',
          ],
          roles: WRITE_ROLES,
          params: [
            { name: 'mailbox_id', in: 'path', type: 'integer', required: true, description: 'The mailbox’s id.' },
            { name: 'label', in: 'body', type: 'string', description: 'A new name, 1–120 characters.' },
            {
              name: 'timezone',
              in: 'body',
              type: 'string',
              description: 'An IANA time zone, for example `America/Chicago`.',
            },
            { name: 'greeting_mode', in: 'body', type: 'string', description: '`standard` or `custom`.' },
            {
              name: 'active_greeting_id',
              in: 'body',
              type: 'integer',
              description: 'One of this mailbox’s greetings.',
            },
          ],
          returns: 'The updated mailbox.',
          statuses: [
            ok('Updated (an empty body changes nothing).'),
            S401,
            { code: 403, when: 'A read-only user, or a field only Granite can change (`status`, transcription).' },
            notFound('The mailbox'),
            {
              code: 422,
              when: '`custom` with no usable greeting, a greeting from another mailbox, or an invalid name or time zone.',
            },
          ],
          example: {
            request:
              `curl -X PATCH "$BASE/voicemail/mailboxes/12" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"greeting_mode": "custom", "active_greeting_id": 31}\'',
            response: MAILBOX_EXAMPLE,
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-pin',
          method: 'PUT',
          path: '/voicemail/mailboxes/{mailbox_id}/pin',
          title: 'Set the PIN',
          summary: 'Set or change the mailbox PIN.',
          roles: WRITE_ROLES,
          params: [
            { name: 'mailbox_id', in: 'path', type: 'integer', required: true, description: 'The mailbox’s id.' },
            { name: 'pin', in: 'body', type: 'string', required: true, description: '4–10 digits, sent as a string.' },
          ],
          returns: 'No body.',
          statuses: [
            { code: 204, when: 'The PIN is set.' },
            S401,
            S403_EDIT,
            notFound('The mailbox'),
            { code: 422, when: 'Not 4–10 digits.' },
          ],
          example: {
            request:
              `curl -X PUT "$BASE/voicemail/mailboxes/12/pin" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"pin": "482916"}\'',
            response: '(204 No Content)',
          },
        },
      ],
    },
    {
      id: 'messages',
      title: 'Messages',
      intro: 'Inbox, Saved and Trash. Trash is emptied automatically after 30 days.',
      entries: [
        {
          kind: 'endpoint',
          id: 'vm-messages',
          method: 'GET',
          path: '/voicemail/mailboxes/{mailbox_id}/messages',
          title: 'List messages',
          summary: 'One folder of a mailbox, newest first, paged.',
          roles: READ_ROLES,
          params: [
            { name: 'mailbox_id', in: 'path', type: 'integer', required: true, description: 'The mailbox’s id.' },
            { name: 'folder', in: 'query', type: 'string', description: '`inbox` (default), `saved` or `trash`.' },
            { name: 'limit', in: 'query', type: 'integer', description: 'Page size, 1–200. Default `50`.' },
            { name: 'offset', in: 'query', type: 'integer', description: 'Rows to skip. Default `0`.' },
          ],
          returns: '`{ items: [messages], total, unread }` for the folder.',
          fields: [
            ...MESSAGE_FIELDS.map((f) => ({ ...f, name: `items[].${f.name}` })),
            { name: 'total', type: 'integer', description: 'Messages in the folder.' },
            { name: 'unread', type: 'integer', description: 'Unread messages in the folder.' },
          ],
          statuses: [
            ok(),
            S401,
            notFound('The mailbox'),
            { code: 422, when: 'An unknown `folder`, or `limit` out of range.' },
          ],
          example: {
            request: `curl "$BASE/voicemail/mailboxes/12/messages?folder=inbox&limit=1" ${AUTH_HEADER}`,
            response: `{\n  "items": [\n${at(MESSAGE_EXAMPLE)}\n  ],\n  "total": 5,\n  "unread": 2\n}`,
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-message-play',
          method: 'POST',
          path: '/voicemail/messages/{message_id}/playback-token',
          title: 'Play or download a message',
          summary: 'Get a 2-minute link to the recording. Marks the message read.',
          description: [
            'Fetch the returned `url` from your portal host — no `Authorization` header is needed, the link carries its own token. The audio is WAV and `Range` requests are supported. With `download: true` the link downloads as a file.',
            'An expired link answers `401`; ask for a new one.',
          ],
          roles: READ_ROLES,
          params: [
            { name: 'message_id', in: 'path', type: 'integer', required: true, description: 'The message’s id.' },
            {
              name: 'download',
              in: 'body',
              type: 'boolean',
              description: '`true` for a download link. Default `false`; the body may be omitted.',
            },
          ],
          returns: 'The link.',
          fields: TOKEN_FIELDS,
          statuses: [ok(), S401, notFound('The message'), S503],
          example: {
            request:
              `curl -X POST "$BASE/voicemail/messages/5012/playback-token" ${AUTH_HEADER}\n` +
              '\n' +
              '# then fetch the audio (no Authorization header)\n' +
              'curl -o message.wav "https://<your portal host>/api/v1/voicemail/messages/5012/audio?t=eyJ…"',
            response: '{\n  "url": "/api/v1/voicemail/messages/5012/audio?t=eyJ…",\n  "expires_in": 120\n}',
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-message-update',
          method: 'PATCH',
          path: '/voicemail/messages/{message_id}',
          title: 'Mark read or save',
          summary: 'Set `is_read` and/or `is_saved` (saved messages move to Saved).',
          roles: WRITE_ROLES,
          params: [
            { name: 'message_id', in: 'path', type: 'integer', required: true, description: 'The message’s id.' },
            { name: 'is_read', in: 'body', type: 'boolean', description: 'Read or unread.' },
            {
              name: 'is_saved',
              in: 'body',
              type: 'boolean',
              description: '`true` moves it to Saved; `false` back to the Inbox.',
            },
          ],
          returns: 'The updated message.',
          fields: MESSAGE_FIELDS,
          statuses: [ok(), S401, S403_EDIT, notFound('The message')],
          example: {
            request:
              `curl -X PATCH "$BASE/voicemail/messages/5012" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"is_saved": true}\'',
            response: MESSAGE_EXAMPLE.replace('"is_saved": false', '"is_saved": true'),
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-message-trash',
          method: 'DELETE',
          path: '/voicemail/messages/{message_id}',
          title: 'Move to Trash',
          summary: 'Move a message to Trash. It can be restored for 30 days.',
          roles: WRITE_ROLES,
          params: [
            { name: 'message_id', in: 'path', type: 'integer', required: true, description: 'The message’s id.' },
          ],
          returns: 'The message, now with `deleted_at` set.',
          statuses: [ok(), S401, S403_EDIT, notFound('The message')],
          example: {
            request: `curl -X DELETE "$BASE/voicemail/messages/5012" ${AUTH_HEADER}`,
            response: MESSAGE_EXAMPLE.replace('"deleted_at": null', '"deleted_at": "2026-10-22T15:01:12+00:00"'),
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-message-restore',
          method: 'POST',
          path: '/voicemail/messages/{message_id}/restore',
          title: 'Restore from Trash',
          summary: 'Take a message out of Trash (its Saved state is unchanged).',
          roles: WRITE_ROLES,
          params: [
            { name: 'message_id', in: 'path', type: 'integer', required: true, description: 'The message’s id.' },
          ],
          returns: 'The message, with `deleted_at` cleared.',
          statuses: [ok(), S401, S403_EDIT, notFound('The message')],
          example: {
            request: `curl -X POST "$BASE/voicemail/messages/5012/restore" ${AUTH_HEADER}`,
            response: MESSAGE_EXAMPLE,
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-message-purge',
          method: 'DELETE',
          path: '/voicemail/messages/{message_id}/purge',
          title: 'Delete forever',
          summary: 'Permanently delete a message and its recording. Can’t be undone.',
          description: ['Works on any message, in Trash or not. The recording and its transcript are erased.'],
          roles: WRITE_ROLES,
          params: [
            { name: 'message_id', in: 'path', type: 'integer', required: true, description: 'The message’s id.' },
          ],
          returns: 'No body.',
          statuses: [{ code: 204, when: 'Deleted.' }, S401, S403_EDIT, notFound('The message'), S503],
          example: {
            request: `curl -X DELETE "$BASE/voicemail/messages/5012/purge" ${AUTH_HEADER}`,
            response: '(204 No Content)',
          },
        },
      ],
    },
    {
      id: 'transcripts',
      title: 'Transcripts',
      intro: 'Optional: Granite switches transcription on per mailbox. Text is only present when `status` is `done`.',
      entries: [
        {
          kind: 'endpoint',
          id: 'vm-transcript',
          method: 'GET',
          path: '/voicemail/messages/{message_id}/transcript',
          title: 'Get a transcript',
          summary: 'A message’s transcript and its status. Doesn’t mark the message read.',
          roles: READ_ROLES,
          params: [
            { name: 'message_id', in: 'path', type: 'integer', required: true, description: 'The message’s id.' },
          ],
          returns: 'The transcript. Sent with `Cache-Control: no-store` — don’t cache it.',
          fields: [
            { name: 'message_id', type: 'integer', description: 'The message.' },
            {
              name: 'status',
              type: 'string',
              description: '`pending`, `processing`, `done`, `empty` (no speech), `failed` or `disabled`.',
            },
            { name: 'text', type: 'string', description: 'The transcript when `done`; else `null`.' },
            { name: 'confidence', type: 'number', description: '0–1 when `done`; else `null`.' },
            { name: 'language', type: 'string', description: 'For example `en-US`, or `null`.' },
            {
              name: 'segments[]',
              type: 'array',
              description: '`start_ms`, `end_ms`, `text`, `confidence` per stretch of speech.',
            },
            { name: 'completed_at', type: 'string (date-time)', description: 'When it finished, or `null`.' },
            {
              name: 'can_retry',
              type: 'boolean',
              description: 'Whether `POST …/transcript/retry` would be accepted for you.',
            },
          ],
          statuses: [
            ok(),
            S401,
            notFound('The message'),
            { code: 500, when: 'The transcript couldn’t be verified and isn’t shown.' },
            S503,
          ],
          example: {
            request: `curl "$BASE/voicemail/messages/5012/transcript" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "message_id": 5012,\n' +
              '  "status": "done",\n' +
              '  "text": "Hi, it\'s Jamie from the water department, please call me back.",\n' +
              '  "confidence": 0.93,\n' +
              '  "language": "en-US",\n' +
              '  "segments": [\n' +
              '    { "start_ms": 400, "end_ms": 4900, "text": "Hi, it\'s Jamie from the water department,", "confidence": 0.95 }\n' +
              '  ],\n' +
              '  "completed_at": "2026-10-22T14:11:31+00:00",\n' +
              '  "can_retry": false\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-snippets',
          method: 'GET',
          path: '/voicemail/mailboxes/{mailbox_id}/transcript-snippets',
          title: 'Transcript previews',
          summary: 'The start of each transcript for up to 50 messages of one mailbox.',
          description: ['Messages that aren’t in this mailbox are left out of the result.'],
          roles: READ_ROLES,
          params: [
            { name: 'mailbox_id', in: 'path', type: 'integer', required: true, description: 'The mailbox’s id.' },
            {
              name: 'ids',
              in: 'query',
              type: 'string',
              required: true,
              description: 'Comma-separated message ids, at most 50.',
            },
          ],
          returns: '`{ items: [...], unavailable }`. Sent with `Cache-Control: no-store`.',
          fields: [
            { name: 'items[].message_id', type: 'integer', description: 'The message.' },
            { name: 'items[].status', type: 'string', description: 'The transcript status.' },
            { name: 'items[].snippet', type: 'string', description: 'The start of the text when `done`; else `null`.' },
            {
              name: 'unavailable',
              type: 'boolean',
              description: '`true` when some text couldn’t be read just now — try again shortly.',
            },
          ],
          statuses: [
            ok(),
            S401,
            notFound('The mailbox'),
            { code: 422, when: 'Ids that aren’t numbers, or more than 50.' },
          ],
          example: {
            request: `curl "$BASE/voicemail/mailboxes/12/transcript-snippets?ids=5012,5011" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "items": [\n' +
              '    { "message_id": 5012, "status": "done", "snippet": "Hi, it\'s Jamie from the water department…" },\n' +
              '    { "message_id": 5011, "status": "pending", "snippet": null }\n' +
              '  ],\n' +
              '  "unavailable": false\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-transcript-retry',
          method: 'POST',
          path: '/voicemail/messages/{message_id}/transcript/retry',
          title: 'Retry a transcript',
          summary: 'Queue a transcript again after it failed, found no speech, or was skipped.',
          roles: WRITE_ROLES,
          params: [
            { name: 'message_id', in: 'path', type: 'integer', required: true, description: 'The message’s id.' },
          ],
          returns: '`202` with `{ message_id, status: "pending" }`.',
          statuses: [
            { code: 202, when: 'Queued.' },
            S401,
            S403_EDIT,
            notFound('The message'),
            {
              code: 409,
              when: 'Transcription is off for the mailbox, the message is in Trash, or the transcript is done or already in progress.',
            },
          ],
          example: {
            request: `curl -X POST "$BASE/voicemail/messages/5011/transcript/retry" ${AUTH_HEADER}`,
            response: '{\n  "message_id": 5011,\n  "status": "pending"\n}',
          },
        },
      ],
    },
    {
      id: 'greetings',
      title: 'Greetings',
      intro: 'Up to 20 greetings per mailbox; choose the one callers hear with “Change a mailbox”.',
      entries: [
        {
          kind: 'endpoint',
          id: 'vm-greetings',
          method: 'GET',
          path: '/voicemail/mailboxes/{mailbox_id}/greetings',
          title: 'List greetings',
          summary: 'A mailbox’s greetings, newest first.',
          roles: READ_ROLES,
          params: [
            { name: 'mailbox_id', in: 'path', type: 'integer', required: true, description: 'The mailbox’s id.' },
          ],
          returns: 'An array of greetings (not paged).',
          fields: [
            { name: '[].id', type: 'integer', description: 'The greeting’s id.' },
            { name: '[].mailbox_id', type: 'integer', description: 'Its mailbox.' },
            { name: '[].label', type: 'string', description: 'Its name.' },
            { name: '[].duration_ms', type: 'integer', description: 'Length, milliseconds.' },
            { name: '[].size_bytes', type: 'integer', description: 'Size.' },
            { name: '[].is_active', type: 'boolean', description: 'Whether it’s the mailbox’s chosen greeting.' },
            { name: '[].created_at', type: 'string (date-time)', description: 'When it was uploaded.' },
          ],
          statuses: [ok(), S401, notFound('The mailbox')],
          example: {
            request: `curl "$BASE/voicemail/mailboxes/12/greetings" ${AUTH_HEADER}`,
            response:
              '[\n' +
              '  { "id": 31, "mailbox_id": 12, "label": "After hours", "duration_ms": 9200,\n' +
              '    "size_bytes": 294444, "is_active": true, "created_at": "2026-10-20T15:10:02+00:00" }\n' +
              ']',
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-greeting-upload',
          method: 'POST',
          path: '/voicemail/mailboxes/{mailbox_id}/greetings',
          title: 'Upload a greeting',
          summary: 'Upload a WAV recording as a new greeting, optionally making it active.',
          description: [
            'Send the raw audio as the body with `Content-Type: audio/wav` — not a form upload. The file must be 16-bit PCM, mono, 8 or 16 kHz, at most 2 minutes and 5 MB.',
          ],
          roles: WRITE_ROLES,
          params: [
            { name: 'mailbox_id', in: 'path', type: 'integer', required: true, description: 'The mailbox’s id.' },
            { name: 'label', in: 'query', type: 'string', description: 'A name for the greeting. Default “Greeting”.' },
            {
              name: 'activate',
              in: 'query',
              type: 'boolean',
              description: '`true` makes it the chosen greeting and switches the mailbox to `custom`. Default `false`.',
            },
          ],
          returns: '`201` with the new greeting (the list fields).',
          statuses: [
            { code: 201, when: 'Uploaded.' },
            S401,
            S403_EDIT,
            notFound('The mailbox'),
            { code: 409, when: 'The mailbox already has 20 greetings.' },
            { code: 413, when: 'Larger than 5 MB.' },
            { code: 415, when: 'Not a WAV file.' },
            { code: 422, when: 'Not 16-bit mono 8/16 kHz PCM, damaged, or longer than 2 minutes.' },
            S503,
          ],
          example: {
            request:
              `curl -X POST "$BASE/voicemail/mailboxes/12/greetings?label=After%20hours&activate=true" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: audio/wav" \\\n' +
              '  --data-binary @after-hours.wav',
            response:
              '{\n' +
              '  "id": 32,\n' +
              '  "mailbox_id": 12,\n' +
              '  "label": "After hours",\n' +
              '  "duration_ms": 9200,\n' +
              '  "size_bytes": 294444,\n' +
              '  "is_active": true,\n' +
              '  "created_at": "2026-10-22T15:05:40+00:00"\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-greeting-play',
          method: 'POST',
          path: '/voicemail/greetings/{greeting_id}/playback-token',
          title: 'Play a greeting',
          summary: 'Get a 2-minute link to a greeting’s audio.',
          description: ['Use the link exactly as for messages — no `Authorization` header needed.'],
          roles: READ_ROLES,
          params: [
            { name: 'greeting_id', in: 'path', type: 'integer', required: true, description: 'The greeting’s id.' },
          ],
          returns: 'The link.',
          fields: TOKEN_FIELDS,
          statuses: [ok(), S401, notFound('The greeting'), S503],
          example: {
            request: `curl -X POST "$BASE/voicemail/greetings/31/playback-token" ${AUTH_HEADER}`,
            response: '{\n  "url": "/api/v1/voicemail/greetings/31/audio?t=eyJ…",\n  "expires_in": 120\n}',
          },
        },
        {
          kind: 'endpoint',
          id: 'vm-greeting-delete',
          method: 'DELETE',
          path: '/voicemail/greetings/{greeting_id}',
          title: 'Delete a greeting',
          summary: 'Delete a greeting. If it was the chosen one, the mailbox goes back to the standard greeting.',
          roles: WRITE_ROLES,
          params: [
            { name: 'greeting_id', in: 'path', type: 'integer', required: true, description: 'The greeting’s id.' },
          ],
          returns: 'No body.',
          statuses: [{ code: 204, when: 'Deleted.' }, S401, S403_EDIT, notFound('The greeting'), S503],
          example: {
            request: `curl -X DELETE "$BASE/voicemail/greetings/31" ${AUTH_HEADER}`,
            response: '(204 No Content)',
          },
        },
      ],
    },
  ],
};
