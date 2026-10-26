/**
 * Calls & reports. Sources: routers/cdrs.py (GET "", /summary, /activity,
 * /{uuid} — get_support_read_filter; tenant rows built from the allowlist in
 * services/tenant_redaction.py: minutes only, answer/end floored to the
 * minute, no cost/rating/routing fields) and routers/reports.py (overview,
 * trend, numbers, calls, calls.csv, my-numbers — report_scope /
 * get_support_read_filter). Ingest, rating and attestation routes are NOT
 * documented.
 */
import { AUTH_HEADER, S401, S503, notFound, ok } from '../common';
import { READ_ROLES, type FieldDoc, type ParamDoc, type SectionDoc } from '../types';

/** The filter set GET /cdrs and /cdrs/summary share (routers/cdrs.py _build_cdr_filters). */
const CDR_FILTERS: readonly ParamDoc[] = [
  {
    name: 'start_date',
    in: 'query',
    type: 'string (date-time)',
    description: 'Window start, ISO 8601, inclusive. No offset = UTC. Default: 24 hours ago.',
  },
  { name: 'end_date', in: 'query', type: 'string (date-time)', description: 'Window end, inclusive. Default: now.' },
  {
    name: 'product_type',
    in: 'query',
    type: 'string',
    description: 'One product, for example `rcf`, `trunk` or `voicemail`; `all` or empty = every product.',
  },
  { name: 'direction', in: 'query', type: 'string', description: '`inbound` or `outbound`.' },
  {
    name: 'number',
    in: 'query',
    type: 'string',
    description: 'One of your numbers, any format: the number called (inbound) or the caller ID (outbound).',
  },
  { name: 'destination', in: 'query', type: 'string', description: 'Destination prefix, for example `+1617`.' },
  { name: 'trunk_id', in: 'query', type: 'integer', description: 'Only calls on this SIP trunk of yours.' },
];

/** Per-call fields a customer receives (TENANT_CDR_FIELDS), the documented subset. */
const CALL_FIELDS: readonly FieldDoc[] = [
  { name: 'uuid', type: 'string', description: 'The call’s id — use it with `GET /cdrs/{uuid}`.' },
  { name: 'product_type', type: 'string', description: 'The product that handled the call, for example `rcf`.' },
  { name: 'direction', type: 'string', description: '`inbound` or `outbound`.' },
  { name: 'caller_id', type: 'string', description: 'The calling number.' },
  { name: 'destination', type: 'string', description: 'The number the call went to.' },
  { name: 'start_time', type: 'string (date-time)', description: 'When the call started.' },
  {
    name: 'answer_time',
    type: 'string (date-time)',
    description: 'When it was answered, rounded down to the minute; `null` if unanswered.',
  },
  { name: 'end_time', type: 'string (date-time)', description: 'When it ended, rounded down to the minute.' },
  {
    name: 'duration_minutes',
    type: 'integer',
    description: 'Talk time in whole minutes, to the nearest minute: `0` if unanswered, at least `1` if answered.',
  },
  {
    name: 'hangup_cause',
    type: 'string',
    description: 'Why the call ended, for example `NORMAL_CLEARING` or `NO_ANSWER`.',
  },
  { name: 'sip_code', type: 'integer', description: 'The final SIP response code, for example `200` or `486`.' },
  {
    name: 'call_quality_grade',
    type: 'string',
    description: '`great`, `good`, `fair` or `poor` — the worse of the two audio directions; `null` if not graded.',
  },
  {
    name: 'call_quality_status',
    type: 'string',
    description: 'Why the call is or isn’t graded — see the call detail endpoint.',
  },
  {
    name: 'call_mos',
    type: 'number',
    description: 'Call voice quality, 1–5 (the worse direction); `null` if not graded.',
  },
  { name: 'trunk_id', type: 'integer', description: 'Your SIP trunk, for trunk calls; else `null`.' },
  {
    name: 'stir_badge',
    type: 'string',
    description: 'STIR/SHAKEN attestation level (`A`, `B` or `C`) when one applied; else `null`.',
  },
];

const CALL_EXAMPLE =
  '{\n' +
  '  "uuid": "9c1e7a3d-5b2f-4f0e-8a51-2d6c1b9e4f70",\n' +
  '  "product_type": "rcf",\n' +
  '  "direction": "inbound",\n' +
  '  "caller_id": "+16175550190",\n' +
  '  "destination": "+16175550123",\n' +
  '  "start_time": "2026-10-22T13:58:02+00:00",\n' +
  '  "answer_time": "2026-10-22T13:58:00+00:00",\n' +
  '  "end_time": "2026-10-22T14:01:00+00:00",\n' +
  '  "duration_minutes": 3,\n' +
  '  "hangup_cause": "NORMAL_CLEARING",\n' +
  '  "sip_code": 200,\n' +
  '  "call_quality_grade": "great",\n' +
  '  "call_quality_status": "rated",\n' +
  '  "call_mos": 4.41,\n' +
  '  "trunk_id": null,\n' +
  '  "stir_badge": "A"\n' +
  '}';

const indent = (s: string, n: number) => s.replace(/^/gm, ' '.repeat(n));

/** Shared report params (routers/reports.py report_scope). */
const REPORT_PARAMS: readonly ParamDoc[] = [
  {
    name: 'start',
    in: 'query',
    type: 'string (date)',
    required: true,
    description: 'First day, `YYYY-MM-DD`, in `tz`.',
  },
  {
    name: 'end',
    in: 'query',
    type: 'string (date)',
    required: true,
    description: 'Last day, inclusive. At most 366 days after `start`.',
  },
  {
    name: 'tz',
    in: 'query',
    type: 'string',
    description: 'IANA time zone for days and hours. Default `America/New_York`.',
  },
  {
    name: 'numbers',
    in: 'query',
    type: 'string',
    description: 'Comma-separated list of your numbers (up to 500). Numbers that aren’t yours are ignored.',
  },
];

const REPORT_STATUSES = [
  ok(),
  S401,
  { code: 422, when: 'Missing or invalid dates, a range over 366 days, an unknown time zone, or too many numbers.' },
  S503,
];

const GRADES = '`great` (MOS ≥ 4.34), `good` (≥ 4.02), `fair` (≥ 3.60), `poor`, or `none` when nothing was graded';

export const CALLS: SectionDoc = {
  label: 'Calls & reports',
  intro:
    'Call records with voice quality, roll-ups, and the same reports the portal shows. Minutes only, never seconds.',
  groups: [
    {
      id: 'records',
      title: 'Call records',
      intro: 'One record per call, from every product on your account.',
      entries: [
        {
          kind: 'endpoint',
          id: 'cdrs-list',
          method: 'GET',
          path: '/cdrs',
          title: 'Search call records',
          summary: 'Your calls, newest first — the last 24 hours unless you set a window.',
          roles: READ_ROLES,
          params: [
            ...CDR_FILTERS,
            { name: 'limit', in: 'query', type: 'integer', description: 'Page size, 0–1000. Default `100`.' },
            { name: 'offset', in: 'query', type: 'integer', description: 'Rows to skip. Default `0`.' },
          ],
          returns: 'One page of calls plus paging counts.',
          fields: [
            ...CALL_FIELDS.map((f) => ({ ...f, name: `cdrs[].${f.name}` })),
            { name: 'count', type: 'integer', description: 'Calls on this page.' },
            { name: 'total', type: 'integer', description: 'Calls matching the filters, across all pages.' },
            { name: 'limit', type: 'integer', description: 'The page size used.' },
            { name: 'offset', type: 'integer', description: 'The offset used.' },
          ],
          statuses: [
            ok(),
            S401,
            { code: 422, when: 'An invalid date, `limit` outside 0–1000, or a `number` that isn’t a phone number.' },
          ],
          example: {
            request: `curl "$BASE/cdrs?product_type=rcf&start_date=2026-10-22T00:00:00Z&limit=1" ${AUTH_HEADER}`,
            response:
              '{\n' +
              `  "cdrs": [\n${indent(CALL_EXAMPLE, 4)}\n  ],\n` +
              '  "count": 1,\n' +
              '  "total": 412,\n' +
              '  "offset": 0,\n' +
              '  "limit": 1\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'cdrs-get',
          method: 'GET',
          path: '/cdrs/{uuid}',
          title: 'Get one call',
          summary: 'One call with its full voice-quality detail, per audio direction.',
          description: [
            'Calls are graded `great` (MOS ≥ 4.34), `good` (≥ 4.02), `fair` (≥ 3.60) or `poor`. MOS follows the ITU-T G.107 E-model; 4.41 is the best a standard call can score.',
            '`call_quality_status` / `quality_status` is `rated` for a graded call, or says why it isn’t: `unanswered`, `short` (under 5 seconds), `low_sample`, `no_data`, `no_media` (no audio either way — not graded), or `no_rtp` (one-way audio — graded `poor`, with no MOS).',
          ],
          roles: READ_ROLES,
          params: [
            { name: 'uuid', in: 'path', type: 'string', required: true, description: 'The call’s `uuid` from a list.' },
          ],
          returns: 'The call: every field of the search result, plus:',
          fields: [
            { name: 'quality_status', type: 'string', description: 'Grading status of the caller’s audio.' },
            { name: 'quality_grade', type: 'string', description: 'Grade of the caller’s audio.' },
            { name: 'mos', type: 'number', description: 'MOS of the caller’s audio, 1–5.' },
            { name: 'r_factor', type: 'number', description: 'The E-model rating behind it, 0–100.' },
            { name: 'jitter_avg_ms', type: 'number', description: 'Average jitter, milliseconds.' },
            { name: 'jitter_max_ms', type: 'number', description: 'Peak jitter, milliseconds.' },
            { name: 'packet_loss_pct', type: 'number', description: 'Audio packets lost, percent.' },
            { name: 'packet_loss_count', type: 'integer', description: 'Audio packets lost.' },
            { name: 'read_codec', type: 'string', description: 'Codec in use, for example `PCMU`.' },
            { name: 'write_codec', type: 'string', description: 'Codec in use the other way.' },
            {
              name: 'quality_by_direction.caller_audio',
              type: 'object',
              description:
                'What the person called heard: `quality_status`, `quality_grade`, `mos`, `r_factor`, `packet_loss_pct`, `packet_loss_count`, `jitter_avg_ms`, `jitter_max_ms`.',
            },
            {
              name: 'quality_by_direction.callee_audio',
              type: 'object',
              description:
                'What the caller heard, same keys; `null` when the call had no onward leg (voicemail, for example).',
            },
          ],
          statuses: [ok(), S401, notFound('The call')],
          example: {
            request: `curl "$BASE/cdrs/9c1e7a3d-5b2f-4f0e-8a51-2d6c1b9e4f70" ${AUTH_HEADER}`,
            response: CALL_EXAMPLE.replace(
              '\n}',
              ',\n' +
                '  "quality_status": "rated",\n' +
                '  "quality_grade": "great",\n' +
                '  "mos": 4.41,\n' +
                '  "r_factor": 93.2,\n' +
                '  "jitter_avg_ms": 1.9,\n' +
                '  "jitter_max_ms": 6.4,\n' +
                '  "packet_loss_pct": 0.0,\n' +
                '  "packet_loss_count": 0,\n' +
                '  "read_codec": "PCMU",\n' +
                '  "write_codec": "PCMU",\n' +
                '  "quality_by_direction": {\n' +
                '    "caller_audio": { "quality_status": "rated", "quality_grade": "great", "mos": 4.41, "…": "…" },\n' +
                '    "callee_audio": { "quality_status": "rated", "quality_grade": "great", "mos": 4.39, "…": "…" }\n' +
                '  }\n' +
                '}',
            ),
          },
        },
        {
          kind: 'endpoint',
          id: 'cdrs-summary',
          method: 'GET',
          path: '/cdrs/summary',
          title: 'Summarise calls',
          summary: 'Call counts and minutes grouped by day, hour or destination.',
          description: [
            'Takes the same filters as `GET /cdrs`. `day` rows split by product and direction; `hour` rows cover up to the latest 168 hours and carry counts only; `destination` rows are the top 50 destination prefixes (first four characters, for example `+161`).',
          ],
          roles: READ_ROLES,
          params: [
            { name: 'group_by', in: 'query', type: 'string', description: '`day` (default), `hour` or `destination`.' },
            ...CDR_FILTERS,
          ],
          returns: '`{ summary: [rows], group_by }`; each row carries the keys of its grouping.',
          fields: [
            { name: 'summary[].date', type: 'string (date)', description: '`day` rows: the day (UTC).' },
            { name: 'summary[].hour', type: 'string (date-time)', description: '`hour` rows: the hour (UTC).' },
            { name: 'summary[].prefix', type: 'string', description: '`destination` rows: the destination prefix.' },
            { name: 'summary[].product_type', type: 'string', description: '`day` rows: the product.' },
            { name: 'summary[].direction', type: 'string', description: '`day` rows: `inbound` or `outbound`.' },
            { name: 'summary[].total_calls', type: 'integer', description: 'Calls.' },
            { name: 'summary[].answered_calls', type: 'integer', description: 'Answered calls.' },
            {
              name: 'summary[].total_minutes',
              type: 'integer',
              description: '`day` and `destination` rows: answered talk time, whole minutes.',
            },
            {
              name: 'summary[].avg_duration_minutes',
              type: 'number',
              description: '`destination` rows: average answered call, minutes (one decimal).',
            },
            { name: 'group_by', type: 'string', description: 'The grouping used.' },
          ],
          statuses: [ok(), S401, { code: 422, when: 'An unknown `group_by`, or an invalid filter.' }],
          example: {
            request: `curl "$BASE/cdrs/summary?group_by=day&product_type=rcf" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "summary": [\n' +
              '    {\n' +
              '      "date": "2026-10-22",\n' +
              '      "product_type": "rcf",\n' +
              '      "direction": "inbound",\n' +
              '      "total_calls": 412,\n' +
              '      "answered_calls": 361,\n' +
              '      "total_minutes": 1021\n' +
              '    }\n' +
              '  ],\n' +
              '  "group_by": "day"\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'cdrs-activity',
          method: 'GET',
          path: '/cdrs/activity',
          title: 'Call activity over time',
          summary: 'Headline numbers plus a zero-filled series for 24 h, 7, 30 or 90 days.',
          description: [
            'Buckets are hours (`24h`), days (`7d`, `30d`) or ISO weeks (`90d`) in the time zone you pass. Note: when `product_type` is omitted this endpoint counts call forwarding only — pass `all` for every product.',
          ],
          roles: READ_ROLES,
          params: [
            { name: 'range', in: 'query', type: 'string', description: '`24h`, `7d` (default), `30d` or `90d`.' },
            { name: 'tz', in: 'query', type: 'string', description: 'IANA time zone for the buckets. Default `UTC`.' },
            { name: 'product_type', in: 'query', type: 'string', description: 'Default `rcf`; `all` = every product.' },
            { name: 'number', in: 'query', type: 'string', description: 'One of your numbers, any format.' },
            { name: 'destination', in: 'query', type: 'string', description: 'An exact destination number.' },
          ],
          returns: 'The window, headline numbers (`kpis`) and one point per bucket.',
          fields: [
            { name: 'range', type: 'string', description: 'The range used.' },
            { name: 'bucket', type: 'string', description: '`hour`, `day` or `week`.' },
            { name: 'tz', type: 'string', description: 'The time zone used.' },
            { name: 'start', type: 'string (date-time)', description: 'Window start.' },
            { name: 'end', type: 'string (date-time)', description: 'Window end.' },
            { name: 'kpis.calls', type: 'integer', description: 'Calls in the window.' },
            { name: 'kpis.answered', type: 'integer', description: 'Answered calls.' },
            { name: 'kpis.asr_pct', type: 'number', description: 'Answered share, percent; `null` with no calls.' },
            {
              name: 'kpis.avg_duration_minutes',
              type: 'number',
              description: 'Average answered call, minutes (one decimal).',
            },
            { name: 'kpis.graded', type: 'integer', description: 'Calls with a quality grade.' },
            { name: 'kpis.good_or_better', type: 'integer', description: 'Calls graded `good` or `great`.' },
            {
              name: 'kpis.good_share_pct',
              type: 'number',
              description: 'Share of graded calls that were good or better.',
            },
            { name: 'kpis.poor', type: 'integer', description: 'Calls graded `poor`.' },
            { name: 'kpis.one_way', type: 'integer', description: 'Calls with one-way audio.' },
            { name: 'kpis.median_mos', type: 'number', description: 'Median MOS of graded calls.' },
            {
              name: 'points[]',
              type: 'array',
              description:
                'One per bucket: `t` (bucket start), `calls`, `answered`, `missed`, `asr_pct`, `graded`, `good_or_better`, `good_share_pct`, `one_way`, `median_mos`.',
            },
          ],
          statuses: [
            ok(),
            S401,
            { code: 422, when: 'An unknown `range` or time zone, or a `number` that isn’t a phone number.' },
            S503,
          ],
          example: {
            request: `curl "$BASE/cdrs/activity?range=7d&tz=America/New_York&product_type=all" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "range": "7d",\n' +
              '  "bucket": "day",\n' +
              '  "tz": "America/New_York",\n' +
              '  "start": "2026-10-16T00:00:00-04:00",\n' +
              '  "end": "2026-10-22T15:20:00-04:00",\n' +
              '  "kpis": {\n' +
              '    "calls": 2210, "answered": 1934, "asr_pct": 87.5,\n' +
              '    "avg_duration_minutes": 3.2, "graded": 1880, "good_or_better": 1851,\n' +
              '    "good_share_pct": 98.5, "poor": 6, "one_way": 2, "median_mos": 4.41\n' +
              '  },\n' +
              '  "points": [\n' +
              '    { "t": "2026-10-16T00:00:00-04:00", "calls": 318, "answered": 279, "missed": 39, "…": "…" }\n' +
              '  ]\n' +
              '}',
          },
        },
      ],
    },
    {
      id: 'reports',
      title: 'Reports',
      intro: 'The portal’s Reporting page as data: calendar days in your time zone, minutes only.',
      entries: [
        {
          kind: 'endpoint',
          id: 'reports-my-numbers',
          method: 'GET',
          path: '/reports/my-numbers',
          title: 'List every number',
          summary: 'Every number on your account, in every product, with its name and state.',
          roles: READ_ROLES,
          returns: '`{ numbers: [...] }`, sorted by number (up to 5,000).',
          fields: [
            { name: 'numbers[].number', type: 'string', description: 'The number, E.164.' },
            { name: 'numbers[].name', type: 'string', description: 'Its label, or `null`.' },
            {
              name: 'numbers[].product',
              type: 'string',
              description: 'The product it belongs to, for example `rcf`, `trunk` or `voicemail`.',
            },
            {
              name: 'numbers[].enabled',
              type: 'boolean',
              description: 'Whether it’s active (forwarding numbers: not paused).',
            },
            {
              name: 'numbers[].forwards_to',
              type: 'string',
              description: 'Forwarding numbers: the destination; else `null`.',
            },
          ],
          statuses: [ok(), S401, S503],
          example: {
            request: `curl "$BASE/reports/my-numbers" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "numbers": [\n' +
              '    { "number": "+16175550123", "name": "Main office", "product": "rcf", "enabled": true, "forwards_to": "+18005550100" },\n' +
              '    { "number": "+16175550150", "name": "Front desk", "product": "voicemail", "enabled": true, "forwards_to": null }\n' +
              '  ]\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'reports-overview',
          method: 'GET',
          path: '/reports/overview',
          title: 'Report overview',
          summary: 'Totals, the previous period, quality, busiest day and hour, and why calls were missed.',
          roles: READ_ROLES,
          params: REPORT_PARAMS,
          returns: 'One object.',
          fields: [
            { name: 'period', type: 'object', description: '`start`, `end`, `tz`, `days`.' },
            {
              name: 'data_available_from',
              type: 'string (date)',
              description: 'Your earliest call on record, or `null`.',
            },
            {
              name: 'totals',
              type: 'object',
              description:
                '`calls`, `inbound`, `outbound`, `answered`, `missed`, `answer_rate_pct`, `minutes`, `avg_minutes`.',
            },
            {
              name: 'previous_period',
              type: 'object',
              description:
                'The same number of days just before: `start`, `end`, `calls`, `answered`, `minutes`, `answer_rate_pct` — `null` values when there’s no data that far back.',
            },
            {
              name: 'quality',
              type: 'object',
              description: `\`rated_calls\`, \`avg_mos\`, \`pct_good_or_better\`, and \`grade\`: ${GRADES}.`,
            },
            { name: 'busiest_day', type: 'object', description: '`date` and `calls`, or `null`.' },
            { name: 'busiest_hour', type: 'object', description: '`hour` (0–23) and `calls`, or `null`.' },
            {
              name: 'missed_reasons[]',
              type: 'array',
              description:
                '`key`, `label`, `calls`, most calls first. Keys: `no_answer`, `caller_hung_up`, `busy`, `not_in_service`, `declined`, `network`.',
            },
          ],
          statuses: REPORT_STATUSES,
          example: {
            request: `curl "$BASE/reports/overview?start=2026-10-01&end=2026-10-21&tz=America/New_York" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "period": { "start": "2026-10-01", "end": "2026-10-21", "tz": "America/New_York", "days": 21 },\n' +
              '  "data_available_from": "2026-01-15",\n' +
              '  "totals": { "calls": 6630, "inbound": 6630, "outbound": 0, "answered": 5802, "missed": 828,\n' +
              '              "answer_rate_pct": 87.5, "minutes": 18466, "avg_minutes": 3.2 },\n' +
              '  "previous_period": { "start": "2026-09-10", "end": "2026-09-30", "calls": 6312,\n' +
              '                       "answered": 5480, "minutes": 17202, "answer_rate_pct": 86.8 },\n' +
              '  "quality": { "rated_calls": 5640, "avg_mos": 4.39, "grade": "great", "pct_good_or_better": 98.6 },\n' +
              '  "busiest_day": { "date": "2026-10-06", "calls": 412 },\n' +
              '  "busiest_hour": { "hour": 10, "calls": 801 },\n' +
              '  "missed_reasons": [\n' +
              '    { "key": "no_answer", "label": "Nobody picked up", "calls": 611 },\n' +
              '    { "key": "caller_hung_up", "label": "The caller hung up before it was answered", "calls": 190 }\n' +
              '  ]\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'reports-trend',
          method: 'GET',
          path: '/reports/trend',
          title: 'Report trend',
          summary: 'Calls, answered, missed and minutes per day, week or month.',
          description: [
            'Every bucket in the range is present, zero-filled. Without `bucket`, ranges up to 62 days are daily, up to 190 days weekly (weeks start Monday), and longer ranges monthly.',
          ],
          roles: READ_ROLES,
          params: [
            ...REPORT_PARAMS,
            {
              name: 'bucket',
              in: 'query',
              type: 'string',
              description: '`day`, `week` or `month`. Default: chosen from the range length.',
            },
          ],
          returns: '`{ bucket, points: [...] }`.',
          fields: [
            { name: 'bucket', type: 'string', description: 'The bucket used.' },
            { name: 'points[].date', type: 'string (date)', description: 'The bucket’s first day.' },
            { name: 'points[].calls', type: 'integer', description: 'Calls.' },
            { name: 'points[].answered', type: 'integer', description: 'Answered calls.' },
            { name: 'points[].missed', type: 'integer', description: 'Missed calls.' },
            { name: 'points[].minutes', type: 'integer', description: 'Answered talk time, whole minutes.' },
          ],
          statuses: REPORT_STATUSES,
          example: {
            request: `curl "$BASE/reports/trend?start=2026-10-01&end=2026-10-21&tz=America/New_York" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "bucket": "day",\n' +
              '  "points": [\n' +
              '    { "date": "2026-10-01", "calls": 318, "answered": 279, "missed": 39, "minutes": 902 },\n' +
              '    { "date": "2026-10-02", "calls": 0, "answered": 0, "missed": 0, "minutes": 0 }\n' +
              '  ]\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'reports-numbers',
          method: 'GET',
          path: '/reports/numbers',
          title: 'Report by number',
          summary: 'Per-number totals and quality for the period, including numbers with no calls.',
          roles: READ_ROLES,
          params: REPORT_PARAMS,
          returns: '`{ numbers: [...] }`, most calls first (up to 500).',
          fields: [
            { name: 'numbers[].number', type: 'string', description: 'Your number.' },
            { name: 'numbers[].name', type: 'string', description: 'Its label, or `null`.' },
            { name: 'numbers[].product', type: 'string', description: 'The product it belongs to.' },
            {
              name: 'numbers[].forwards_to',
              type: 'string',
              description: 'Forwarding numbers: the destination; else `null`.',
            },
            { name: 'numbers[].calls', type: 'integer', description: 'Calls.' },
            { name: 'numbers[].answered', type: 'integer', description: 'Answered calls.' },
            { name: 'numbers[].missed', type: 'integer', description: 'Missed calls.' },
            {
              name: 'numbers[].answer_rate_pct',
              type: 'number',
              description: 'Answered share, percent; `null` with no calls.',
            },
            { name: 'numbers[].minutes', type: 'integer', description: 'Answered talk time, whole minutes.' },
            { name: 'numbers[].avg_mos', type: 'number', description: 'Average MOS of graded calls, or `null`.' },
            { name: 'numbers[].grade', type: 'string', description: GRADES + '.' },
          ],
          statuses: REPORT_STATUSES,
          example: {
            request: `curl "$BASE/reports/numbers?start=2026-10-01&end=2026-10-21" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "numbers": [\n' +
              '    {\n' +
              '      "number": "+16175550123", "name": "Main office", "product": "rcf",\n' +
              '      "forwards_to": "+18005550100", "calls": 4120, "answered": 3655, "missed": 465,\n' +
              '      "answer_rate_pct": 88.7, "minutes": 11702, "avg_mos": 4.4, "grade": "great"\n' +
              '    }\n' +
              '  ]\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'reports-calls',
          method: 'GET',
          path: '/reports/calls',
          title: 'Report call list',
          summary: 'The period’s calls in plain language, newest first, paged.',
          roles: READ_ROLES,
          params: [
            ...REPORT_PARAMS,
            { name: 'outcome', in: 'query', type: 'string', description: '`all` (default), `answered` or `missed`.' },
            {
              name: 'direction',
              in: 'query',
              type: 'string',
              description: '`all` (default), `inbound` or `outbound`.',
            },
            { name: 'limit', in: 'query', type: 'integer', description: 'Page size, 1–500. Default `50`.' },
            { name: 'offset', in: 'query', type: 'integer', description: 'Rows to skip, 0–100,000. Default `0`.' },
          ],
          returns: '`{ total, calls: [...] }`.',
          fields: [
            { name: 'total', type: 'integer', description: 'Calls matching, across all pages.' },
            { name: 'calls[].id', type: 'string', description: 'The call’s `uuid`.' },
            {
              name: 'calls[].started_at',
              type: 'string (date-time)',
              description: 'Start time in `tz`, with its offset.',
            },
            { name: 'calls[].direction', type: 'string', description: '`inbound` or `outbound`.' },
            { name: 'calls[].from', type: 'string', description: 'The calling number.' },
            { name: 'calls[].to', type: 'string', description: 'The number called.' },
            { name: 'calls[].number', type: 'string', description: 'Your number on the call.' },
            { name: 'calls[].product', type: 'string', description: 'The product that handled it.' },
            { name: 'calls[].outcome', type: 'string', description: '`answered` or `missed`.' },
            {
              name: 'calls[].outcome_label',
              type: 'string',
              description: 'In words: “Answered”, “Answered by voicemail”, or the missed reason.',
            },
            {
              name: 'calls[].missed_reason',
              type: 'string',
              description: 'A `missed_reasons` key, or `null` when answered.',
            },
            { name: 'calls[].length_minutes', type: 'integer', description: 'Talk time, whole minutes.' },
            { name: 'calls[].quality', type: 'string', description: GRADES + '.' },
          ],
          statuses: REPORT_STATUSES,
          example: {
            request: `curl "$BASE/reports/calls?start=2026-10-21&end=2026-10-21&outcome=missed&limit=1" ${AUTH_HEADER}`,
            response:
              '{\n' +
              '  "total": 41,\n' +
              '  "calls": [\n' +
              '    {\n' +
              '      "id": "4b7d0c2e-91aa-4c3e-b0d8-6f1e2a9c5d33",\n' +
              '      "started_at": "2026-10-21T17:42:09-04:00",\n' +
              '      "direction": "inbound",\n' +
              '      "from": "+16175550190",\n' +
              '      "to": "+16175550123",\n' +
              '      "number": "+16175550123",\n' +
              '      "product": "rcf",\n' +
              '      "outcome": "missed",\n' +
              '      "outcome_label": "Nobody picked up",\n' +
              '      "missed_reason": "no_answer",\n' +
              '      "length_minutes": 0,\n' +
              '      "quality": "none"\n' +
              '    }\n' +
              '  ]\n' +
              '}',
          },
        },
        {
          kind: 'endpoint',
          id: 'reports-calls-csv',
          method: 'GET',
          path: '/reports/calls.csv',
          title: 'Download the call list (CSV)',
          summary: 'The same call list as a CSV file, up to 100,000 rows.',
          description: [
            'Takes the same parameters as `GET /reports/calls`, without paging. The `X-Report-Truncated` response header is `true` when more than 100,000 calls matched and the file stops there.',
          ],
          roles: READ_ROLES,
          params: [
            ...REPORT_PARAMS,
            { name: 'outcome', in: 'query', type: 'string', description: '`all` (default), `answered` or `missed`.' },
            {
              name: 'direction',
              in: 'query',
              type: 'string',
              description: '`all` (default), `inbound` or `outbound`.',
            },
          ],
          returns:
            '`text/csv` with columns: Date, Time, Direction, From, To, Your number, Outcome, Length (minutes, rounded), Call quality.',
          statuses: REPORT_STATUSES,
          example: {
            request: `curl -OJ "$BASE/reports/calls.csv?start=2026-10-01&end=2026-10-21" ${AUTH_HEADER}`,
            responseLabel: 'calls_2026-10-01_2026-10-21.csv',
            response:
              'Date,Time,Direction,From,To,Your number,Outcome,"Length (minutes, rounded)",Call quality\n' +
              '2026-10-21,17:42,Inbound,+16175550190,+16175550123,+16175550123,Nobody picked up,0,Not rated',
          },
        },
      ],
    },
  ],
};
