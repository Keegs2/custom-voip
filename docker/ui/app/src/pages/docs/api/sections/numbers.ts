/**
 * Numbers & call forwarding. Sources: routers/number_inventory.py
 * (/available, /my, /{did}/request, /request-release, /cancel-release —
 * get_current_user / get_customer_filter) and routers/rcf.py (list / get /
 * update — get_customer_filter; max_channels admin-only; create/delete are
 * admin provisioning and NOT documented).
 */
import { AUTH_HEADER, S401, S403_EDIT, S422, notFound, ok } from '../common';
import { READ_ROLES, WRITE_ROLES, type FieldDoc, type SectionDoc } from '../types';

const RCF_FIELDS: readonly FieldDoc[] = [
  { name: 'id', type: 'integer', description: 'The entry’s id (usable in place of the number when updating).' },
  { name: 'did', type: 'string', description: 'Your number, E.164.' },
  { name: 'name', type: 'string', description: 'Your label for it, or `null`.' },
  { name: 'forward_to', type: 'string', description: 'Where calls go: an E.164 number, or a 3–6 digit extension.' },
  {
    name: 'ring_timeout',
    type: 'integer',
    description: 'Seconds the destination rings before the call gives up (5–120).',
  },
  {
    name: 'pass_caller_id',
    type: 'boolean',
    description: '`true` shows the original caller’s number at the destination; `false` shows your number.',
  },
  { name: 'enabled', type: 'boolean', description: '`true` = forwarding, `false` = paused.' },
  {
    name: 'failover_to',
    type: 'string',
    description: 'A backup destination saved with the number, or `null`. Not currently used to route calls.',
  },
  {
    name: 'max_channels',
    type: 'integer',
    description: 'Most simultaneous calls on this number; `0` = no limit. Set by Granite.',
  },
  { name: 'customer_id', type: 'integer', description: 'Your account’s id.' },
  { name: 'customer_name', type: 'string', description: 'Your account’s name.' },
];

const RCF_EXAMPLE_ROW =
  '  {\n' +
  '    "id": 118,\n' +
  '    "did": "+16175550123",\n' +
  '    "name": "Main office",\n' +
  '    "forward_to": "+18005550100",\n' +
  '    "ring_timeout": 30,\n' +
  '    "pass_caller_id": true,\n' +
  '    "enabled": true,\n' +
  '    "failover_to": null,\n' +
  '    "max_channels": 0,\n' +
  '    "customer_id": 7,\n' +
  '    "customer_name": "Acme Water Co."\n' +
  '  }';

const LIFECYCLE_FIELDS: readonly FieldDoc[] = [
  { name: 'status', type: 'string', description: 'The number’s status after the change.' },
  { name: 'did', type: 'string', description: 'The number, E.164.' },
  { name: 'customer_id', type: 'integer', description: 'Your account’s id.' },
  { name: 'product_type', type: 'string', description: 'The product the number is for.' },
  { name: 'message', type: 'string', description: 'What happens next, in one sentence.' },
];

export const NUMBERS: SectionDoc = {
  label: 'Numbers & forwarding',
  intro: 'Your numbers, requesting and releasing them, and where each one forwards.',
  groups: [
    {
      id: 'numbers',
      title: 'Your numbers',
      intro: 'Granite reviews every request and release — nothing is added or removed without review.',
      entries: [
        {
          kind: 'endpoint',
          id: 'numbers-my',
          method: 'GET',
          path: '/numbers/my',
          title: 'List your numbers',
          summary: 'Every number on your account with its status, including requests waiting for review.',
          description: [
            '`status` is `assigned`, `reserved` (your request is waiting for Granite’s review) or `release_requested` (a release is waiting for review — the number keeps working until then).',
          ],
          roles: READ_ROLES,
          returns: 'An array, sorted by number (not paged).',
          fields: [
            { name: '[].did', type: 'string', description: 'The number, E.164.' },
            {
              name: '[].product_type',
              type: 'string',
              description: 'The product it belongs to, for example `rcf`, `trunk` or `voicemail`.',
            },
            { name: '[].status', type: 'string', description: '`assigned`, `reserved` or `release_requested`.' },
            { name: '[].city', type: 'string', description: 'City, when known; else `null`.' },
            { name: '[].state', type: 'string', description: 'Two-letter state, when known; else `null`.' },
            {
              name: '[].assigned_at',
              type: 'string (date-time)',
              description: 'When it was assigned or requested, when known; else `null`.',
            },
            { name: '[].notes', type: 'string', description: 'Notes on requests and releases, or `null`.' },
            { name: '[].customer_id', type: 'integer', description: 'Your account’s id.' },
            { name: '[].customer_name', type: 'string', description: 'Your account’s name.' },
          ],
          statuses: [ok(), S401],
          example: {
            request: `curl "$BASE/numbers/my" ${AUTH_HEADER}`,
            response:
              '[\n' +
              '  {\n' +
              '    "did": "+16175550123",\n' +
              '    "product_type": "rcf",\n' +
              '    "status": "assigned",\n' +
              '    "city": "Boston",\n' +
              '    "state": "MA",\n' +
              '    "assigned_at": "2026-01-15T10:00:00+00:00",\n' +
              '    "notes": null,\n' +
              '    "customer_id": 7,\n' +
              '    "customer_name": "Acme Water Co."\n' +
              '  }\n' +
              ']',
          },
        },
        {
          kind: 'endpoint',
          id: 'numbers-available',
          method: 'GET',
          path: '/numbers/available',
          title: 'Find numbers to request',
          summary: 'Browse numbers that are free to request, filtered by place.',
          roles: READ_ROLES,
          params: [
            { name: 'state', in: 'query', type: 'string', description: 'Two-letter state, for example `MA`.' },
            { name: 'city', in: 'query', type: 'string', description: 'Part of a city name, any case.' },
            {
              name: 'area_code',
              in: 'query',
              type: 'string',
              description: 'Three-digit area code, for example `617`.',
            },
            { name: 'search', in: 'query', type: 'string', description: 'Digits that appear anywhere in the number.' },
            { name: 'limit', in: 'query', type: 'integer', description: 'Page size, 1–500. Default `50`.' },
            { name: 'offset', in: 'query', type: 'integer', description: 'Rows to skip. Default `0`.' },
          ],
          returns: 'One page, sorted by number.',
          fields: [
            { name: 'items[].did', type: 'string', description: 'The number, E.164.' },
            { name: 'items[].city', type: 'string', description: 'City.' },
            { name: 'items[].state', type: 'string', description: 'Two-letter state.' },
            { name: 'items[].rate_center', type: 'string', description: 'The number’s rate center.' },
            { name: 'total', type: 'integer', description: 'Matches across all pages.' },
            { name: 'limit', type: 'integer', description: 'The page size used.' },
            { name: 'offset', type: 'integer', description: 'The offset used.' },
          ],
          statuses: [ok(), S401, S422],
          example: {
            request: `curl "$BASE/numbers/available?state=MA&area_code=617&limit=2" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "items": [\n' +
              '    { "did": "+16175550141", "city": "Boston", "state": "MA", "rate_center": "BOSTON" },\n' +
              '    { "did": "+16175550142", "city": "Boston", "state": "MA", "rate_center": "BOSTON" }\n' +
              '  ],\n' +
              '  "total": 38,\n' +
              '  "limit": 2,\n' +
              '  "offset": 0\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'numbers-request',
          method: 'POST',
          path: '/numbers/{did}/request',
          title: 'Request a number',
          summary: 'Reserve an available number for your account, pending review.',
          description: [
            'The number is reserved for you straight away and shows as `reserved` in `GET /numbers/my` until Granite completes the assignment.',
          ],
          roles: WRITE_ROLES,
          params: [
            {
              name: 'did',
              in: 'path',
              type: 'string',
              required: true,
              description: 'The number, in any phone format (URL-encode a leading `+` as `%2B`).',
            },
            {
              name: 'product_type',
              in: 'body',
              type: 'string',
              required: true,
              description: '`rcf` (call forwarding) or `trunk` (SIP trunk).',
            },
            { name: 'notes', in: 'body', type: 'string', description: 'A note for the reviewer.' },
          ],
          returns: 'The reservation.',
          fields: LIFECYCLE_FIELDS,
          statuses: [
            ok('Reserved — `status` is `reserved`.'),
            S401,
            S403_EDIT,
            { code: 404, when: 'The number isn’t one we offer.' },
            { code: 409, when: 'The number isn’t available — `detail` says its current status.' },
            { code: 422, when: 'Not a phone number, or an unknown `product_type`.' },
          ],
          example: {
            request:
              `curl -X POST "$BASE/numbers/%2B16175550141/request" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"product_type": "rcf", "notes": "Second line for the Boston office"}\'',
            response:
              '{\n' +
              '  "status": "reserved",\n' +
              '  "did": "+16175550141",\n' +
              '  "customer_id": 7,\n' +
              '  "product_type": "rcf",\n' +
              '  "message": "Number reserved. An administrator will review and complete the assignment."\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'numbers-request-release',
          method: 'POST',
          path: '/numbers/{did}/request-release',
          title: 'Request a release',
          summary: 'Ask Granite to remove a number from your account.',
          description: [
            'The number keeps working normally until the release is approved. Withdraw the request with `POST /numbers/{did}/cancel-release`.',
          ],
          roles: WRITE_ROLES,
          params: [
            {
              name: 'did',
              in: 'path',
              type: 'string',
              required: true,
              description: 'One of your numbers, in any phone format.',
            },
            { name: 'notes', in: 'body', type: 'string', description: 'A reason, added to the number’s notes.' },
          ],
          returns: 'The new state.',
          fields: LIFECYCLE_FIELDS,
          statuses: [
            ok('Requested — `status` is `release_requested`.'),
            S401,
            notFound('The number'),
            { code: 409, when: 'The number isn’t `assigned`, or a release is already waiting for review.' },
            S422,
          ],
          example: {
            request:
              `curl -X POST "$BASE/numbers/%2B16175550123/request-release" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"notes": "Office closed"}\'',
            response:
              '{\n' +
              '  "status": "release_requested",\n' +
              '  "did": "+16175550123",\n' +
              '  "customer_id": 7,\n' +
              '  "product_type": "rcf",\n' +
              '  "message": "Release requested. An administrator will review and complete the release."\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'numbers-cancel-release',
          method: 'POST',
          path: '/numbers/{did}/cancel-release',
          title: 'Cancel a release',
          summary: 'Withdraw a release request; the number stays assigned.',
          roles: WRITE_ROLES,
          params: [
            {
              name: 'did',
              in: 'path',
              type: 'string',
              required: true,
              description: 'The number, in any phone format.',
            },
            { name: 'notes', in: 'body', type: 'string', description: 'A note, added to the number’s notes.' },
          ],
          returns: 'The new state.',
          fields: LIFECYCLE_FIELDS,
          statuses: [
            ok('Withdrawn — `status` is `assigned`.'),
            S401,
            notFound('The number'),
            { code: 409, when: 'There’s no release waiting for review.' },
            S422,
          ],
          example: {
            request: `curl -X POST "$BASE/numbers/%2B16175550123/cancel-release" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "status": "assigned",\n' +
              '  "did": "+16175550123",\n' +
              '  "customer_id": 7,\n' +
              '  "product_type": "rcf",\n' +
              '  "message": "Release request cancelled. The number remains assigned."\n' +
              '}',
          },
        },
      ],
    },
    {
      id: 'forwarding',
      title: 'Call forwarding',
      intro: 'Read and change where your forwarding numbers send calls. Granite adds and removes the entries.',
      entries: [
        {
          kind: 'endpoint',
          id: 'rcf-list',
          method: 'GET',
          path: '/rcf',
          title: 'List forwarding numbers',
          summary: 'Your forwarding numbers and their settings, newest first.',
          description: [
            'Returns at most 100 entries and has no paging. For every number on your account, in every product, use `GET /reports/my-numbers`.',
          ],
          roles: READ_ROLES,
          params: [
            {
              name: 'enabled',
              in: 'query',
              type: 'boolean',
              description: '`true` = only forwarding numbers, `false` = only paused ones.',
            },
          ],
          returns: 'An array of forwarding entries.',
          fields: RCF_FIELDS.map((f) => ({ ...f, name: `[].${f.name}` })),
          statuses: [ok(), S401, S422],
          example: {
            request: `curl "$BASE/rcf?enabled=true" ${AUTH_HEADER}`,
            response: `[\n${RCF_EXAMPLE_ROW}\n]`,
          },
        },
        {
          kind: 'endpoint',
          id: 'rcf-get',
          method: 'GET',
          path: '/rcf/{did}',
          title: 'Get a forwarding number',
          summary: 'One forwarding number by its E.164 number.',
          roles: READ_ROLES,
          params: [
            {
              name: 'did',
              in: 'path',
              type: 'string',
              required: true,
              description: 'The number exactly as stored, E.164 with `+` encoded: `%2B16175550123`.',
            },
          ],
          returns: 'One forwarding entry: the list fields plus `created_at`.',
          fields: [
            ...RCF_FIELDS,
            { name: 'created_at', type: 'string (date-time)', description: 'When the entry was created.' },
          ],
          statuses: [ok(), S401, notFound('The number')],
          example: {
            request: `curl "$BASE/rcf/%2B16175550123" ${AUTH_HEADER}`,
            response: RCF_EXAMPLE_ROW.replace(/^ {2}/gm, '').replace(
              '"customer_name": "Acme Water Co."',
              '"customer_name": "Acme Water Co.",\n  "created_at": "2026-01-15T10:00:00+00:00"',
            ),
          },
        },
        {
          kind: 'endpoint',
          id: 'rcf-update',
          method: 'PATCH',
          path: '/rcf/{id_or_did}',
          title: 'Change forwarding',
          summary: 'Change where a number forwards, how long it rings, caller ID, or pause it.',
          description: [
            'Send only the fields you want to change. `PUT` to the same path behaves exactly the same.',
            'Changes apply to new calls within moments; calls already in progress are unaffected.',
          ],
          roles: WRITE_ROLES,
          params: [
            {
              name: 'id_or_did',
              in: 'path',
              type: 'string',
              required: true,
              description: 'The entry’s `id`, or the number exactly as stored (`%2B16175550123`).',
            },
            {
              name: 'forward_to',
              in: 'body',
              type: 'string',
              description: 'New destination: an E.164 number, a 10-digit US number, or a 3–6 digit extension.',
            },
            {
              name: 'ring_timeout',
              in: 'body',
              type: 'integer',
              description: 'Seconds to ring the destination, 5–120.',
            },
            {
              name: 'pass_caller_id',
              in: 'body',
              type: 'boolean',
              description: '`true` shows the original caller; `false` shows your number.',
            },
            { name: 'enabled', in: 'body', type: 'boolean', description: '`true` to forward, `false` to pause.' },
            { name: 'name', in: 'body', type: 'string', description: 'Your label for the number.' },
            {
              name: 'failover_to',
              in: 'body',
              type: 'string',
              description:
                'A backup destination to store (same formats as `forward_to`). Not currently used to route calls.',
            },
          ],
          returns: 'The updated entry (the list fields).',
          statuses: [
            ok('Updated.'),
            { code: 400, when: 'No fields were sent.' },
            S401,
            { code: 403, when: '`max_channels` was sent — only Granite can change it.' },
            notFound('The number'),
            { code: 422, when: 'A destination isn’t a valid number or extension, or `ring_timeout` is outside 5–120.' },
          ],
          example: {
            request:
              `curl -X PATCH "$BASE/rcf/%2B16175550123" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"forward_to": "+16175550188", "ring_timeout": 25}\'',
            response: RCF_EXAMPLE_ROW.replace(/^ {2}/gm, '')
              .replace('"+18005550100"', '"+16175550188"')
              .replace('"ring_timeout": 30', '"ring_timeout": 25'),
          },
        },
      ],
    },
  ],
};
