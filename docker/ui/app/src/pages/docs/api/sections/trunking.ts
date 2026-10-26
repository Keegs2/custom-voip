/**
 * SIP Trunking (early access). Source: routers/trunks.py — list
 * (get_support_read_filter), detail / stats / ips / dids
 * (get_customer_filter + _get_owned_trunk, 404-no-leak), IP add/remove
 * (owner self-service). NOT documented: create, update, call-path changes,
 * DID assignment (admin provisioning) and GET /trunks/call-paths (a price
 * list, not tenant-scoped).
 */
import { AUTH_HEADER, S401, S422, notFound, ok } from '../common';
import { READ_ROLES, WRITE_ROLES, type FieldDoc, type SectionDoc } from '../types';

const TRUNK_FIELDS: readonly FieldDoc[] = [
  { name: 'id', type: 'integer', description: 'The trunk’s id.' },
  { name: 'trunk_name', type: 'string', description: 'Its name.' },
  { name: 'enabled', type: 'boolean', description: 'Whether it carries calls.' },
  { name: 'max_channels', type: 'integer', description: 'Most simultaneous calls.' },
  { name: 'cps_limit', type: 'integer', description: 'Most new calls per second.' },
  { name: 'call_paths', type: 'integer', description: 'Call paths in its package, or `null`.' },
  { name: 'package_name', type: 'string', description: 'Its call-path package, or `null`.' },
  {
    name: 'auth_type',
    type: 'string',
    description: 'How calls from your PBX are recognised, for example `ip` (from its authorized IPs).',
  },
  { name: 'tech_prefix', type: 'string', description: 'The trunk’s dialling prefix, or `null`.' },
  { name: 'ip_count', type: 'integer', description: 'Authorized IPs.' },
  { name: 'did_count', type: 'integer', description: 'Numbers on the trunk.' },
  { name: 'created_at', type: 'string (date-time)', description: 'When it was set up.' },
  { name: 'customer_id', type: 'integer', description: 'Your account’s id.' },
  { name: 'customer_name', type: 'string', description: 'Your account’s name.' },
];

const TRUNK_EXAMPLE =
  '{\n' +
  '  "id": 12,\n' +
  '  "trunk_name": "hq-primary",\n' +
  '  "enabled": true,\n' +
  '  "max_channels": 25,\n' +
  '  "cps_limit": 5,\n' +
  '  "call_paths": 25,\n' +
  '  "package_name": "25 Call Paths",\n' +
  '  "auth_type": "ip",\n' +
  '  "tech_prefix": null,\n' +
  '  "ip_count": 2,\n' +
  '  "did_count": 15,\n' +
  '  "created_at": "2026-02-01T15:30:00+00:00",\n' +
  '  "customer_id": 7,\n' +
  '  "customer_name": "Acme Water Co."\n' +
  '}';

const TRUNK_ID = {
  name: 'trunk_id',
  in: 'path',
  type: 'integer',
  required: true,
  description: 'One of your trunks.',
} as const;

export const TRUNKING: SectionDoc = {
  label: 'SIP Trunking',
  tag: 'Early access',
  intro:
    'Read your trunks and their live usage, and manage the IPs each trunk accepts calls from. Capacity and numbers are set up by Granite.',
  groups: [
    {
      id: 'trunks',
      title: 'Trunks',
      entries: [
        {
          kind: 'endpoint',
          id: 'trunks-list',
          method: 'GET',
          path: '/trunks',
          title: 'List trunks',
          summary: 'Your SIP trunks with capacity, package and counts, newest first.',
          roles: READ_ROLES,
          params: [
            {
              name: 'enabled',
              in: 'query',
              type: 'boolean',
              description: 'Only enabled (`true`) or disabled (`false`) trunks.',
            },
            { name: 'limit', in: 'query', type: 'integer', description: 'Page size. Default `100`.' },
            { name: 'offset', in: 'query', type: 'integer', description: 'Rows to skip. Default `0`.' },
          ],
          returns: 'An array of trunks.',
          fields: TRUNK_FIELDS.map((f) => ({ ...f, name: `[].${f.name}` })),
          statuses: [ok(), S401, S422],
          example: {
            request: `curl "$BASE/trunks" ${AUTH_HEADER}`,
            response: `[\n${TRUNK_EXAMPLE.replace(/^/gm, '  ')}\n]`,
          },
        },
        {
          kind: 'endpoint',
          id: 'trunks-get',
          method: 'GET',
          path: '/trunks/{trunk_id}',
          title: 'Get a trunk',
          summary: 'One trunk.',
          roles: READ_ROLES,
          params: [TRUNK_ID],
          returns: 'One trunk (the list fields).',
          statuses: [ok(), S401, notFound('The trunk')],
          example: {
            request: `curl "$BASE/trunks/12" ${AUTH_HEADER}`,
            response: TRUNK_EXAMPLE,
          },
        },
        {
          kind: 'endpoint',
          id: 'trunks-stats',
          method: 'GET',
          path: '/trunks/{trunk_id}/stats',
          title: 'Live trunk usage',
          summary: 'Calls on the trunk right now, plus the last hour’s totals.',
          description: ['The portal refreshes this every 15 seconds; polling at a similar pace suits a wallboard.'],
          roles: READ_ROLES,
          params: [TRUNK_ID],
          returns: 'One object.',
          fields: [
            { name: 'trunk_id', type: 'integer', description: 'The trunk.' },
            { name: 'current_channels', type: 'integer', description: 'Calls on the trunk right now.' },
            { name: 'max_channels', type: 'integer', description: 'Most simultaneous calls.' },
            { name: 'channel_utilization', type: 'string', description: 'In use, as a percentage string (`"24.0%"`).' },
            { name: 'cps_limit', type: 'integer', description: 'Most new calls per second.' },
            { name: 'last_hour.total_calls', type: 'integer', description: 'Calls in the last hour.' },
            { name: 'last_hour.answered_calls', type: 'integer', description: 'Answered calls in the last hour.' },
            { name: 'last_hour.asr', type: 'string', description: 'Answered share, as a percentage string.' },
            {
              name: 'last_hour.avg_duration_minutes',
              type: 'number',
              description: 'Average answered call, minutes (one decimal).',
            },
          ],
          statuses: [ok(), S401, notFound('The trunk')],
          example: {
            request: `curl "$BASE/trunks/12/stats" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "trunk_id": 12,\n' +
              '  "current_channels": 6,\n' +
              '  "max_channels": 25,\n' +
              '  "channel_utilization": "24.0%",\n' +
              '  "cps_limit": 5,\n' +
              '  "last_hour": {\n' +
              '    "total_calls": 141,\n' +
              '    "answered_calls": 92,\n' +
              '    "asr": "65.2%",\n' +
              '    "avg_duration_minutes": 3.1\n' +
              '  }\n' +
              '}',
          },
        },
      ],
    },
    {
      id: 'trunk-ips',
      title: 'Authorized IPs',
      intro: 'A trunk accepts calls only from its authorized IPs.',
      entries: [
        {
          kind: 'endpoint',
          id: 'trunk-ips-list',
          method: 'GET',
          path: '/trunks/{trunk_id}/ips',
          title: 'List authorized IPs',
          summary: 'The addresses a trunk accepts calls from.',
          roles: READ_ROLES,
          params: [TRUNK_ID],
          returns: 'An array.',
          fields: [
            { name: '[].id', type: 'integer', description: 'The entry’s id (to remove it).' },
            { name: '[].ip_address', type: 'string', description: 'The address.' },
            { name: '[].description', type: 'string', description: 'Your note, or `null`.' },
          ],
          statuses: [ok(), S401, notFound('The trunk')],
          example: {
            request: `curl "$BASE/trunks/12/ips" ${AUTH_HEADER}`,
            response: '[\n  { "id": 31, "ip_address": "203.0.113.50", "description": "HQ firewall" }\n]',
          },
        },
        {
          kind: 'endpoint',
          id: 'trunk-ips-add',
          method: 'POST',
          path: '/trunks/{trunk_id}/ips',
          title: 'Add an authorized IP',
          summary: 'Allow calls from another public IPv4 address.',
          roles: WRITE_ROLES,
          params: [
            TRUNK_ID,
            {
              name: 'ip_address',
              in: 'body',
              type: 'string',
              required: true,
              description: 'The public IPv4 address your PBX sends calls from.',
            },
            {
              name: 'description',
              in: 'body',
              type: 'string',
              description: 'A note for your records, up to 100 characters.',
            },
          ],
          returns: 'The new entry.',
          fields: [
            { name: 'id', type: 'integer', description: 'The entry’s id.' },
            { name: 'ip_address', type: 'string', description: 'The address.' },
            { name: 'description', type: 'string', description: 'Your note, or `null`.' },
          ],
          statuses: [
            ok('Added.'),
            S401,
            notFound('The trunk'),
            { code: 409, when: 'The address is already on this trunk.' },
            S422,
          ],
          example: {
            request:
              `curl -X POST "$BASE/trunks/12/ips" ${AUTH_HEADER} \\\n` +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"ip_address": "203.0.113.51", "description": "Backup firewall"}\'',
            response: '{\n  "id": 32,\n  "ip_address": "203.0.113.51",\n  "description": "Backup firewall"\n}',
          },
        },
        {
          kind: 'endpoint',
          id: 'trunk-ips-remove',
          method: 'DELETE',
          path: '/trunks/{trunk_id}/ips/{ip_id}',
          title: 'Remove an authorized IP',
          summary: 'Stop accepting calls from an address.',
          roles: WRITE_ROLES,
          params: [
            TRUNK_ID,
            { name: 'ip_id', in: 'path', type: 'integer', required: true, description: 'The entry’s `id`.' },
          ],
          returns: '`{ "status": "deleted" }`.',
          statuses: [ok('Removed.'), S401, notFound('The trunk or entry')],
          example: {
            request: `curl -X DELETE "$BASE/trunks/12/ips/32" ${AUTH_HEADER}`,
            response: '{\n  "status": "deleted"\n}',
          },
        },
      ],
    },
    {
      id: 'trunk-numbers',
      title: 'Numbers',
      entries: [
        {
          kind: 'endpoint',
          id: 'trunk-dids',
          method: 'GET',
          path: '/trunks/{trunk_id}/dids',
          title: 'List a trunk’s numbers',
          summary: 'The inbound numbers on a trunk.',
          description: [
            'To add a number to a trunk, request it with `POST /numbers/{did}/request` and `product_type: "trunk"` — the same review flow as any number.',
          ],
          roles: READ_ROLES,
          params: [TRUNK_ID],
          returns: 'An array.',
          fields: [
            { name: '[].id', type: 'integer', description: 'The entry’s id.' },
            { name: '[].did', type: 'string', description: 'The number, E.164.' },
          ],
          statuses: [ok(), S401, notFound('The trunk')],
          example: {
            request: `curl "$BASE/trunks/12/dids" ${AUTH_HEADER}`,
            response: '[\n  { "id": 88, "did": "+16175550160" }\n]',
          },
        },
      ],
    },
  ],
};
