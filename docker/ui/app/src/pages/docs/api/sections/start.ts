/**
 * Getting started — base URL, sign-in, roles, errors, conventions and the
 * account endpoints. Sources: middleware/auth.py (session JWT on every
 * route), auth/security.py (8 h expiry), routers/auth.py (login, me, team),
 * routers/customers.py GET /me (tenant-redacted).
 */
import { AUTH_HEADER, BASE_URL, S401, S422, ok } from '../common';
import { READ_ROLES, type SectionDoc } from '../types';

export const START: SectionDoc = {
  label: 'Getting started',
  intro: 'Sign in, send the token, read errors — everything every endpoint shares.',
  groups: [
    {
      id: 'basics',
      title: 'Basics',
      entries: [
        {
          kind: 'topic',
          id: 'base-url',
          title: 'Base URL and format',
          blocks: [
            {
              type: 'p',
              text:
                'The API gives your own systems the same data and settings you manage in the portal: your numbers ' +
                'and call forwarding, call records and reports, Visual Voicemail and SIP trunks. Send every request ' +
                'over HTTPS; every response covers your account only.',
            },
            {
              type: 'code',
              label: 'base URL',
              code: `# The address you sign in to the portal with, plus /api/v1\nBASE="${BASE_URL}"`,
            },
            {
              type: 'list',
              items: [
                'Requests and responses are JSON (`Content-Type: application/json`). The one exception is a voicemail greeting upload, which sends WAV audio.',
                'Times are ISO 8601 with a UTC offset (`2026-10-22T19:20:00+00:00`). Report endpoints take a time zone and answer in it.',
                'Responses can carry fields this reference doesn’t list, and the examples show documented fields only. Ignore anything unlisted — only documented fields are supported.',
              ],
            },
            {
              type: 'callout',
              text: 'Programmable voice — placing and controlling calls through the API — is on our roadmap. It isn’t part of the API today.',
            },
          ],
        },
        {
          kind: 'topic',
          id: 'authentication',
          title: 'Authentication',
          blocks: [
            {
              type: 'p',
              text:
                'The API uses the same sign-in as the portal. Exchange a portal user’s email and password for a token ' +
                'with `POST /auth/login`, then send the token as a Bearer token on every request. There are no separate API keys.',
            },
            {
              type: 'code',
              label: 'sign in, then call the API',
              code:
                '# 1. Sign in (jq pulls out the token; any JSON tool works)\n' +
                'TOKEN=$(curl -s -X POST "$BASE/auth/login" \\\n' +
                '  -H "Content-Type: application/json" \\\n' +
                '  -d \'{"email": "you@example.com", "password": "your-password"}\' \\\n' +
                '  | jq -r .access_token)\n' +
                '\n' +
                '# 2. Send it on every request\n' +
                `curl "$BASE/numbers/my" ${AUTH_HEADER}`,
            },
            {
              type: 'list',
              items: [
                'A token is valid for 8 hours from sign-in. There is no refresh token: when a request returns `401`, sign in again and retry it.',
                'A token acts as the user who signed in, with that user’s role. Keep it secret, like a password.',
                'A disabled user can’t sign in (`403`), and their existing sign-ins stop working within a minute (`401`).',
              ],
            },
          ],
        },
        {
          kind: 'topic',
          id: 'roles',
          title: 'Roles and scope',
          blocks: [
            {
              type: 'p',
              text: 'Each user on your account has one of two roles. Every endpoint lists the roles that may call it.',
            },
            {
              type: 'table',
              head: ['Role', 'What it can do'],
              rows: [
                [
                  '`user`',
                  'Read everything on your account and make changes: forwarding settings, number requests and releases, voicemail, and SIP trunk IPs.',
                ],
                ['`readonly`', 'Read everything on your account — including playing voicemail — but make no changes.'],
              ],
            },
            {
              type: 'p',
              text:
                'Every endpoint works on your own account only. Endpoints that act on one of your objects answer ' +
                '`404 Not Found` for anything not on your account, exactly as if it didn’t exist.',
            },
          ],
        },
        {
          kind: 'topic',
          id: 'errors',
          title: 'Errors and status codes',
          blocks: [
            {
              type: 'p',
              text: 'An error returns a JSON body with a `detail` field — usually one sentence you can show to a person:',
            },
            {
              type: 'code',
              label: 'error',
              code: '{\n  "detail": "RCF number not found"\n}',
            },
            {
              type: 'p',
              text: 'When a field fails type checks, a `422` lists each problem instead:',
            },
            {
              type: 'code',
              label: 'validation error (422)',
              code:
                '{\n' +
                '  "detail": [\n' +
                '    {\n' +
                '      "type": "less_than_equal",\n' +
                '      "loc": ["query", "limit"],\n' +
                '      "msg": "Input should be less than or equal to 1000",\n' +
                '      "input": "5000",\n' +
                '      "ctx": { "le": 1000 }\n' +
                '    }\n' +
                '  ]\n' +
                '}',
            },
            {
              type: 'table',
              head: ['Status', 'Meaning'],
              limit: 7,
              noun: 'status codes',
              rows: [
                ['`200` OK', 'The request succeeded.'],
                [
                  '`401` Unauthorized',
                  'The token is missing, invalid or expired — sign in again. Also: a wrong current password, or an expired voicemail playback link.',
                ],
                ['`403` Forbidden', 'Your role can’t do this, or the field can only be changed by Granite.'],
                ['`404` Not Found', 'It doesn’t exist, or it isn’t on your account.'],
                ['`409` Conflict', 'The current state blocks the request — for example a number that isn’t available.'],
                ['`422` Unprocessable', 'A parameter or field is missing or invalid.'],
                [
                  '`503` Unavailable',
                  'Briefly unavailable, or the query ran too long. Retry with backoff; honour `Retry-After` when present.',
                ],
                ['`201` Created', 'A greeting was uploaded.'],
                ['`202` Accepted', 'Work was queued (a transcript retry).'],
                ['`204` No Content', 'Done, with no body (deletes, PIN changes).'],
                ['`400` Bad Request', 'The request can’t be applied as sent — for example an update with no fields.'],
                ['`413` / `415`', 'A greeting upload is too large / isn’t a WAV file.'],
                [
                  '`500` Server Error',
                  'An unexpected problem on our side. Retry later, and contact Granite support if it persists.',
                ],
              ],
            },
            {
              type: 'callout',
              text:
                'Retry `503` and network errors with exponential backoff. Don’t resend other `4xx` responses unchanged — ' +
                'fix the request first (or sign in again after a `401`).',
            },
          ],
        },
        {
          kind: 'topic',
          id: 'conventions',
          title: 'Conventions',
          blocks: [
            {
              type: 'list',
              items: [
                'Phone numbers are E.164: `+`, country code, number — `+16175550123`. Where an endpoint accepts any format, a bare 10-digit number is read as a US number (`6175550123` → `+16175550123`).',
                'A number inside a URL path: encode the `+` as `%2B` (`/rcf/%2B16175550123`).',
                'Most lists either return everything (some up to a stated cap) or page with `limit` and `offset` and include a `total`. `GET /trunks` is the exception: a plain array paged with `limit` and `offset`, with no `total`. Each endpoint says which.',
                'Call records and reports give talk time in whole minutes, rounded to the nearest minute — an answered call counts as at least 1. Averages (`avg_duration_minutes`, `avg_minutes`) may have one decimal.',
                'Other durations name their unit: `ring_timeout` and `max_message_seconds` are seconds, and voicemail lengths (`duration_ms`) are milliseconds.',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'account',
      title: 'Your account',
      intro: 'Sign in, and read who you are and what your account holds.',
      entries: [
        {
          kind: 'endpoint',
          id: 'auth-login',
          method: 'POST',
          path: '/auth/login',
          title: 'Sign in',
          summary: 'Exchange a portal email and password for an 8-hour token.',
          description: [
            'The only endpoint that needs no token. Use the returned `access_token` as `Authorization: Bearer <token>` on every other request.',
          ],
          roles: READ_ROLES,
          params: [
            {
              name: 'email',
              in: 'body',
              type: 'string',
              required: true,
              description: 'The portal user’s email address.',
            },
            { name: 'password', in: 'body', type: 'string', required: true, description: 'That user’s password.' },
          ],
          returns: 'An object with the token and the signed-in user.',
          fields: [
            { name: 'access_token', type: 'string', description: 'The token. Valid for 8 hours.' },
            { name: 'token_type', type: 'string', description: 'Always `bearer`.' },
            { name: 'user.id', type: 'integer', description: 'The user’s id.' },
            { name: 'user.email', type: 'string', description: 'The user’s email.' },
            { name: 'user.name', type: 'string', description: 'The user’s display name.' },
            { name: 'user.role', type: 'string', description: '`user` or `readonly`.' },
            { name: 'user.customer_id', type: 'integer', description: 'Your account’s id.' },
            { name: 'user.customer_name', type: 'string', description: 'Your account’s name.' },
            {
              name: 'user.account_type',
              type: 'string',
              description: 'Your account type, for example `rcf` or `hybrid`.',
            },
          ],
          statuses: [
            ok('Signed in.'),
            { code: 401, when: 'The email or password is wrong.' },
            { code: 403, when: 'The user is disabled.' },
            S422,
          ],
          example: {
            request:
              'curl -X POST "$BASE/auth/login" \\\n' +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"email": "jane@example.com", "password": "your-password"}\'',
            response:
              '{\n' +
              '  "access_token": "eyJhbGciOi…",\n' +
              '  "token_type": "bearer",\n' +
              '  "user": {\n' +
              '    "id": 42,\n' +
              '    "email": "jane@example.com",\n' +
              '    "name": "Jane Smith",\n' +
              '    "role": "user",\n' +
              '    "customer_id": 7,\n' +
              '    "customer_name": "Acme Water Co.",\n' +
              '    "account_type": "rcf"\n' +
              '  }\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'auth-me',
          method: 'GET',
          path: '/auth/me',
          title: 'Who am I',
          summary: 'The signed-in user, read fresh (not from the token).',
          roles: READ_ROLES,
          returns: 'The signed-in user.',
          fields: [
            { name: 'id', type: 'integer', description: 'The user’s id.' },
            { name: 'email', type: 'string', description: 'The user’s email.' },
            { name: 'name', type: 'string', description: 'The user’s display name.' },
            { name: 'role', type: 'string', description: '`user` or `readonly`.' },
            { name: 'status', type: 'string', description: '`active` for any user who can sign in.' },
            { name: 'customer_id', type: 'integer', description: 'Your account’s id.' },
            { name: 'customer_name', type: 'string', description: 'Your account’s name.' },
            { name: 'account_type', type: 'string', description: 'Your account type, for example `rcf` or `hybrid`.' },
            { name: 'created_at', type: 'string (date-time)', description: 'When the user was created.' },
            { name: 'last_login', type: 'string (date-time)', description: 'The user’s latest sign-in.' },
          ],
          statuses: [ok(), S401],
          example: {
            request: `curl "$BASE/auth/me" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "id": 42,\n' +
              '  "email": "jane@example.com",\n' +
              '  "name": "Jane Smith",\n' +
              '  "role": "user",\n' +
              '  "status": "active",\n' +
              '  "customer_id": 7,\n' +
              '  "customer_name": "Acme Water Co.",\n' +
              '  "account_type": "rcf",\n' +
              '  "created_at": "2026-03-02T14:05:11+00:00",\n' +
              '  "last_login": "2026-10-22T13:58:40+00:00"\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'auth-me-update',
          method: 'PUT',
          path: '/auth/me',
          title: 'Update your profile',
          summary: 'Change your display name and/or password.',
          description: [
            'Send `name`, or `current_password` with `new_password`, or both. Any user may change their own profile, read-only users included.',
          ],
          roles: READ_ROLES,
          params: [
            { name: 'name', in: 'body', type: 'string', description: 'A new display name.' },
            { name: 'current_password', in: 'body', type: 'string', description: 'Required with `new_password`.' },
            { name: 'new_password', in: 'body', type: 'string', description: 'At least 8 characters.' },
          ],
          returns: 'The updated user, in the same shape as `GET /auth/me`.',
          statuses: [
            ok('Updated.'),
            { code: 400, when: 'Nothing to update, or only one of the two password fields was sent.' },
            { code: 401, when: '`current_password` is wrong (or the token is invalid).' },
            { code: 422, when: '`new_password` is shorter than 8 characters.' },
          ],
          example: {
            request:
              `curl -X PUT "$BASE/auth/me" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"name": "Jane A. Smith"}\'',
            response:
              '{\n' +
              '  "id": 42,\n' +
              '  "email": "jane@example.com",\n' +
              '  "name": "Jane A. Smith",\n' +
              '  "role": "user",\n' +
              '  "status": "active",\n' +
              '  "customer_id": 7,\n' +
              '  "customer_name": "Acme Water Co.",\n' +
              '  "account_type": "rcf",\n' +
              '  "created_at": "2026-03-02T14:05:11+00:00",\n' +
              '  "last_login": "2026-10-22T13:58:40+00:00"\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'auth-team',
          method: 'GET',
          path: '/auth/team',
          title: 'List your team',
          summary: 'Every user on your account, oldest first.',
          roles: READ_ROLES,
          returns: 'An array of users (not paged).',
          fields: [
            { name: '[].id', type: 'integer', description: 'The user’s id.' },
            { name: '[].email', type: 'string', description: 'The user’s email.' },
            { name: '[].name', type: 'string', description: 'The user’s display name.' },
            { name: '[].role', type: 'string', description: '`user` or `readonly`.' },
            { name: '[].status', type: 'string', description: '`active` or `disabled`.' },
            { name: '[].created_at', type: 'string (date-time)', description: 'When the user was created.' },
            { name: '[].last_login', type: 'string (date-time)', description: 'Latest sign-in, or `null`.' },
            { name: '[].is_self', type: 'boolean', description: '`true` for the user making the request.' },
          ],
          statuses: [ok(), S401],
          example: {
            request: `curl "$BASE/auth/team" ${AUTH_HEADER}`,
            response:
              '[\n' +
              '  {\n' +
              '    "id": 42,\n' +
              '    "email": "jane@example.com",\n' +
              '    "name": "Jane Smith",\n' +
              '    "role": "user",\n' +
              '    "status": "active",\n' +
              '    "created_at": "2026-03-02T14:05:11+00:00",\n' +
              '    "last_login": "2026-10-22T13:58:40+00:00",\n' +
              '    "is_self": true\n' +
              '  }\n' +
              ']',
          },
        },
        {
          kind: 'endpoint',
          id: 'customers-me',
          method: 'GET',
          path: '/customers/me',
          title: 'Your account',
          summary: 'Your account’s name, type and how many numbers it holds.',
          roles: READ_ROLES,
          returns: 'Your account.',
          fields: [
            { name: 'id', type: 'integer', description: 'Your account’s id.' },
            { name: 'name', type: 'string', description: 'Your account’s name.' },
            { name: 'account_type', type: 'string', description: 'For example `rcf` or `hybrid`.' },
            { name: 'status', type: 'string', description: 'For example `active`.' },
            { name: 'created_at', type: 'string (date-time)', description: 'When the account was opened.' },
            { name: 'counts.numbers.total', type: 'integer', description: 'Numbers on the account, every product.' },
            {
              name: 'counts.numbers.by_product',
              type: 'object',
              description:
                'Count per product, for example `{"rcf": 12, "voicemail": 2}`. Products with no numbers are left out.',
            },
            { name: 'counts.trunks', type: 'integer', description: 'SIP trunks on the account.' },
          ],
          statuses: [ok(), S401],
          example: {
            request: `curl "$BASE/customers/me" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "id": 7,\n' +
              '  "name": "Acme Water Co.",\n' +
              '  "account_type": "rcf",\n' +
              '  "status": "active",\n' +
              '  "created_at": "2026-01-15T10:00:00+00:00",\n' +
              '  "counts": {\n' +
              '    "numbers": { "total": 14, "by_product": { "rcf": 12, "voicemail": 2 } },\n' +
              '    "trunks": 0\n' +
              '  }\n' +
              '}',
          },
        },
      ],
    },
  ],
};
