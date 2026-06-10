# Homer pipeline ground truth — live call 2026-06-10 12:08 PM ET

Raw ClickHouse rows for one production RCF call, captured for pipeline-accuracy
verification. Source: `qryn.samples_v3` JOIN `qryn.time_series` on the services
VM, filtered by Call-ID. This call rendered BROKEN in the SIP ladder (columns
out of order, 100 Trying before INVITE) — these rows are the acceptance fixture:
after the pipeline fixes, THIS call must render correctly.

- A-leg Call-ID: `258530374_92210034@67.231.13.185` (Bandwidth TC1 ATL -> VIP -> SBC-1 -> FS)
- B-leg Call-ID: `7523baca-df89-123f-0b87-4201c0a80a02` (FS -> SBC-1 -> hairpin VIP -> BW-DAL)
- From +15087282017 ("GRABHORN KEEGAN"), To +16174544217 (RCF DID), forward_to +17742184477
- node label: 100 = Kamailio SBC-1 capture, 200 = FreeSWITCH capture
- src/dst labels are ALIAS NAMES (heplify ip-alias.lua rewrites IPs pre-label):
  SBC-VIP=34.24.133.82, SBC-1=10.142.0.100 (+34.74.71.32 ext), FreeSWITCH=192.168.10.2/34.139.119.135, BW-ATL=67.231.13.185, BW-DAL=67.231.2.12

## KEY ANOMALIES (verified)

1. TIMESTAMP CORRUPTION: rows whose timestamp_ns ends in `000` carry the HEP
   capture timestamp (microsecond precision x1000). Rows with full ns entropy
   (e.g. .725832231) were stamped at INGEST, not capture — they are ~15-20ms
   LATE. All three captures of the A-leg INVITE (the largest packets) have
   ingest stamps, so the INVITE sorts AFTER its own 100 Trying (.709698).
   True wire time of the carrier INVITE is <= .709698.
2. DUPLICATES: same wire message appears up to 3x — node 200 (FS capture),
   node 100 (Kamailio sip_trace), node 100 again (Kamailio tm trace_flag
   duplicate). Example: FS 100 Trying at .711764(200) / .711906(100) / .711975(100).
3. B-LEG HAIRPIN: FS in-dialog ACK/BYE consume inner RR (SBC-1) then outer
   Route (VIP = same box loopback) -> SBC sends to ITSELF. Captured as
   src=SBC-VIP dst=SBC-VIP rows; the final BYE to BW-DAL carries TWO SBC Vias
   (z9hG4bKdf74.19b28c... AND z9hG4bKdf74.5d4f72...) proving double traversal.
4. via_branch is NOT a label — only extractable from the raw SIP message text.

## Command 1 output (timestamp_ns, node, method, response, src, sp, dst, dp, call_id)

(A=258530374_92210034@67.231.13.185, B=7523baca-df89-123f-0b87-4201c0a80a02)

| timestamp_ns | node | method | response | src | dst | leg |
|---|---|---|---|---|---|---|
| 1781107707709698000 | 100 | INVITE | 100 | SBC-VIP | BW-ATL | A |
| 1781107707711764000 | 200 | INVITE | 100 | FreeSWITCH:5080 | SBC-1 | A |
| 1781107707711906000 | 100 | INVITE | 100 | FreeSWITCH:5080 | SBC-1 | A |
| 1781107707711975000 | 100 | INVITE | 100 | FreeSWITCH:5080 | SBC-1 | A |
| 1781107707725832231 | 200 | INVITE | INVITE | SBC-1 | FreeSWITCH:5080 | A |
| 1781107707725964951 | 100 | INVITE | INVITE | BW-ATL | SBC-VIP | A (from cmd2; raw INVITE, single carrier Via) |
| 1781107707726162321 | 100 | INVITE | INVITE | SBC-1 | FreeSWITCH:5080 | A (from cmd2; has double RR) |
| 1781107707742226000 | 200 | INVITE | INVITE | FreeSWITCH:5090 | SBC-1 | B |
| 1781107707742493000 | 100 | INVITE | INVITE | FreeSWITCH:5090 | SBC-1 | B |
| 1781107707743538000 | 100 | INVITE | INVITE | SBC-1 | BW-DAL | B |
| 1781107707743660000 | 200 | INVITE | 100 | SBC-1 | FreeSWITCH:5090 | B |
| 1781107707744163757 | 100 | INVITE | 100 | SBC-1 | FreeSWITCH:5090 | B |
| 1781107707782462000 | 100 | INVITE | 100 | BW-DAL | SBC-1 | B |
| 1781107707783249707 | 100 | INVITE | 100 | BW-DAL | SBC-1 | B (dup) |
| 1781107709185304000 | 100 | INVITE | 183 | BW-DAL | SBC-1 | B (cmd2) |
| 1781107709185408000 | 100 | INVITE | 183 | BW-DAL | SBC-1 | B (dup) |
| 1781107709185708000 | 100 | INVITE | 183 | SBC-1 | FreeSWITCH:5090 | B |
| 1781107709186068000 | 200 | INVITE | 183 | SBC-1 | FreeSWITCH:5090 | B |
| 1781107709192878000 | 200 | INVITE | 183 | FreeSWITCH:5080 | SBC-1 | A |
| 1781107709193095000 | 100 | INVITE | 183 | FreeSWITCH:5080 | SBC-1 | A |
| 1781107709193198000 | 100 | INVITE | 183 | FreeSWITCH:5080 | SBC-1 | A (dup) |
| 1781107709193498000 | 100 | INVITE | 183 | SBC-VIP | BW-ATL | A (top Via = carrier branch 08Ba) |
| 1781107716961399000 | 100 | INVITE | 200 | BW-DAL | SBC-1 | B (cmd2) |
| 1781107716961507000 | 100 | INVITE | 200 | BW-DAL | SBC-1 | B (dup) |
| 1781107716961845000 | 100 | INVITE | 200 | SBC-1 | FreeSWITCH:5090 | B |
| 1781107716962111000 | 200 | INVITE | 200 | SBC-1 | FreeSWITCH:5090 | B |
| 1781107716963730000 | 100 | ACK | ACK | FreeSWITCH:5090 | SBC-1 | B |
| 1781107716964232921 | 200 | ACK | ACK | FreeSWITCH:5090 | SBC-1 | B |
| 1781107716964553000 | 100 | ACK | ACK | SBC-VIP | SBC-VIP | B (HAIRPIN; ACK toward BW-DAL, 2 SBC Vias) |
| 1781107716968394000 | 100 | INVITE | 200 | FreeSWITCH:5080 | SBC-1 | A |
| 1781107716969065850 | 200 | INVITE | 200 | FreeSWITCH:5080 | SBC-1 | A (cmd2) |
| 1781107716969202430 | 100 | INVITE | 200 | FreeSWITCH:5080 | SBC-1 | A (dup) |
| 1781107716969222690 | 100 | INVITE | 200 | SBC-VIP | BW-ATL | A |
| 1781107716982023000 | 100 | ACK | ACK | BW-ATL | SBC-VIP | A |
| 1781107716982951000 | 200 | ACK | ACK | SBC-1 | FreeSWITCH:5080 | A |
| 1781107719831940000 | 100 | BYE | BYE | BW-ATL | SBC-VIP | A |
| 1781107719832565000 | 100 | BYE | BYE | SBC-1 | FreeSWITCH:5080 | A |
| 1781107719832982000 | 200 | BYE | BYE | SBC-1 | FreeSWITCH:5080 | A (node 200 capture of same; cmd2 shows request) |
| 1781107719855009000 | 100 | BYE | 200 | FreeSWITCH:5080 | SBC-1 | A (cmd2) |
| 1781107719855154000 | 100 | BYE | 200 | SBC-VIP | BW-ATL | A |
| 1781107719855833958 | 100 | BYE | 200 | FreeSWITCH:5080 | SBC-1 | A (dup) |
| 1781107719855856089 | 200 | BYE | 200 | FreeSWITCH:5080 | SBC-1 | A (dup) |
| 1781107719859529000 | 200 | BYE | BYE | FreeSWITCH:5090 | SBC-1 | B |
| 1781107719859695000 | 100 | BYE | BYE | FreeSWITCH:5090 | SBC-1 | B |
| 1781107719860191000 | 100 | BYE | BYE | SBC-VIP | SBC-VIP | B (HAIRPIN hop 1) |
| 1781107719860515000 | 100 | BYE | BYE | SBC-VIP(?) | ? | B (2 Vias, cmd2) |
| 1781107719860949000 | 100 | BYE | BYE | SBC-1 | BW-DAL | B (3 Vias incl TWO SBC branches df74.19b + df74.5d4) |
| 1781107719898013000 | 100 | BYE | 200 | BW-DAL | SBC-1 | B |
| 1781107719898138000 | 100 | BYE | 200 | BW-DAL | SBC-1 | B (dup, 3 Vias) |
| 1781107719898207000 | 100 | BYE | 200 | SBC-VIP | SBC-VIP | B (hairpin reply leg, 2 Vias) |
| 1781107719898705000 | 100 | BYE | 200 | SBC-1 | FreeSWITCH:5090 | B |
| 1781107719899101758 | 100 | BYE | 200 | SBC-VIP | SBC-VIP | B (dup) |
| 1781107719899201658 | 100 | BYE | 200 | SBC-VIP | SBC-VIP | B (dup) |
| 1781107719899410898 | 200 | BYE | 200 | SBC-1 | FreeSWITCH:5090 | B (cmd2) |

## Via branches (from cmd 2, for dedup identity work)

- A-leg carrier INVITE top Via: `67.231.13.185:5060;branch=z9hG4bK08Ba7efa3017830e2bd`
- A-leg SBC->FS INVITE top Via: `34.24.133.82:5060;branch=z9hG4bK79c3.49d25b1a6d3a4e506a2af21826383424.0` (carrier Via below it)
- B-leg FS->SBC INVITE top Via: `34.139.119.135:5090;branch=z9hG4bK27BQ6UKj92ZmK`
- B-leg SBC->BW-DAL INVITE top Via: `34.24.133.82:5060;branch=z9hG4bK0084.73dcff95228238048cf2c298db7317bd.0` (FS Via below)
- B-leg ACK (FS): `branch=z9hG4bK3g5F8p4N6Bp7e`; hairpin ACK adds `34.24.133.82...branch=z9hG4bK0084.32a8b9fec7117640447d5da94c17b911.0`
- A-leg ACK (carrier): `branch=z9hG4bK08Baa84e66caef5a95f`
- A-leg BYE (carrier): `branch=z9hG4bK08Bab52184caef5a95f`; SBC->FS adds `branch=z9hG4bK5ac3.5a172f63a79098c41d166db24090cd7a.0`
- B-leg BYE (FS): `branch=z9hG4bK4Sy89HNS3mcta`; SBC hop1 adds `df74.5d4f729ab536b412e2ee083db179b161.0`; hairpin hop2 adds `df74.19b28c42a94ee2b1ead233ea7cb92d08.0`
- 200 OK (BYE, B-leg) responses seen with 1, 2, and 3 Via stacks as they retrace the hairpin.

## heplify-server deployed config (docker inspect, 2026-06-10)

FORCEALEGID=false, HEPADDR=0.0.0.0:9060, HEPTCPADDR=0.0.0.0:9061,
LOKICALLIDLABELS=true, ALEGIDS=X-CID, LOKIIPPORTLABELS=true, DEDUP=false(?
truncated in paste), LOKIURL=http://qryn:3100/loki/api/v1/push, LOKIBULK=200,
LOKITIMER=1, LOKIFROMTOLABELS=true, SCRIPTENABLE=true, SCRIPTFOLDER=/scripts,
DBSHEMA=mock, DBDRIVER=mock. Image: ghcr.io/sipcapture/heplify-server (no tag).

## Label set example (qryn time_series)

{"call_id":"...","dst_ip":"FreeSWITCH","dst_port":"5080","from":"...","hostname":"6590f5a05a8c","job":"heplify-server","method":"INVITE","node":"200","protocol":"udp","response":"INVITE","src_ip":"SBC-1","src_port":"5060","to":"...","type":"sip"}

NOTE: requests have response=<method> (e.g. response="INVITE" for the request
itself); replies have response=<code>. No via_branch label exists.

## Operational note

The naive diagnostic JOIN (`samples_v3 INNER JOIN time_series ON fingerprint`)
OOM'd ClickHouse at 1.86 GiB because the right side loads the ENTIRE
time_series table. Pre-filtering time_series by the gin fingerprint subquery
fixed it. homer.py `_query_clickhouse_by_callids` uses the unfiltered JOIN
shape and is exposed to the same failure as time_series grows.
