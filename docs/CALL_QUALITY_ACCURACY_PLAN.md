# Call-Quality Accuracy — Implementation Plan + Contract

**Branch:** `feat/call-quality-accuracy` (base `RCF-V1` 1b90da2) · **Migration:** `50` (48/49 taken; the parked `46_metrics_roles` is NOT renumbered) · **FS pin:** `0a54a48f3762ddb7ac9c263b7800f6da09fda3dd`

This document is the **contract** for four parallel implementers (FS / API+DB / Grafana / UI). Names, units, types and NULL rules below are binding. If an implementer finds the contract wrong, they stop and raise it. They do not improvise a different name.

---

## 0. The problem in one paragraph, and the decisions

Today every quality number on the platform comes from FreeSWITCH's `do_mos()` (switch_rtp.c:1575-1622 @0a54a48). That function has these problems:
- It scores zero inbound RTP as MOS 4.50 / R 100. It is initialised to 4.5 at switch_rtp.c:4531-4532 and clamps `R<0||R>100 → 100`.
- It resets `flaws` to 0 whenever `recved < flaws` (line 1578). Because of that reset and the consecutive-flaw penalty, the score does not go down steadily as loss goes up, and bursty loss can score better than light loss.
- It counts CNG timer ticks (line 7871), autoflush syncs (line 7321) and DTMF/hold resets as "flaws".

The API then made it worse:
- It divides flaws by packets and calls that loss %, which overstates loss about 3x and counts reorder as loss.
- It labels the autoflush skip counter as `packet_loss_count`.
- It makes up `jitter_avg_ms` from `(min+max)/2` of a running variance.
- It relabels MOS as `r_factor`.
- It grades with three different threshold sets.

Production (7 days, A rows): 65% of answered calls are exactly 4.50. The 4 answered calls with no inbound RTP (including one real 11 s Sinch one-way call) scored 4.50, and 17 unanswered calls carry a MOS.

**Decisions (binding):**

1. **FreeSWITCH source patch** `docker/freeswitch/patches/0001-rcf-rtp-quality-v1.patch`. It is additive and changes no behaviour. It adds an RFC 3550 §A.1 sequence tracker (true expected / lost / loss events / reordered / SSRC epochs, never reset) and RFC 3550 §6.4.1 interarrival jitter, using the kernel receive timestamp when available. It exports them as new `rtp_audio_in_*` channel variables at hangup. All existing variables are unchanged.
2. **We compute MOS ourselves** with the ITU-T G.107 E-model (packet-loss impairment only). The pure Python module is `services/call_quality.py`, mirrored by IMMUTABLE SQL functions in migration 50 (a parity test enforces they agree). FS's own MOS/R are kept only in `fs_mos` / `fs_quality_pct` for traceability.
3. **Grading happens only when there is evidence.** An answered call of at least 5 s with at least 250 inbound packets is graded. An answered call of at least 5 s with less than 10% of the expected inbound packets is `no_rtp` (one-way audio), graded **poor**, with MOS NULL. Everything else gets a status and NULL quality numbers.
4. **Existing column names are kept but now carry honest values** (`mos`, `r_factor`, `packet_loss_pct`, `packet_loss_count`, `jitter_avg_ms`, `jitter_max_ms`), so no customer field is renamed. `quality_pct` and `jitter_min_ms` are deprecated and written NULL. Raw FS values move to new `fs_*` / `rtp_audio_in_skip_packet_count` columns. History is recomputed by an idempotent backfill.
5. **Call quality = the worse direction.** A-in (caller→platform) and the answered carrier B-in (callee→platform) are combined into `call_quality_*` / `call_mos` on the A row by a SQL function, `cdr_refresh_call_quality()`. Both ingests call it after their own INSERT commits, so it is correct whichever CDR arrives first.
6. **One grade definition**, taken from the G.107/G.109 R bands (R 90/80/70). It is applied to the stored 2-dp MOS: **great ≥ 4.34 · good ≥ 4.02 · fair ≥ 3.60 · poor < 3.60 (or no_rtp) · none = not graded**. It is used everywhere.
7. **Alerting (DROPPED 2026-09-24 — dashboards only):** `scripts/backup/media_guard.sh`, an on-VM SQL watchdog modelled on `asr_guard.sh`. It uses the existing `revup-alert` → Cloud Logging page path, plus a Grafana panel. vmalert is not used (it cannot read PG).

---

## A. FreeSWITCH patch (FS agent)

### A.1 Files and anchor points in 0a54a48

MD5 values below were verified against the scratch copy. Line numbers are @0a54a48.

| File | Anchor | Change |
|---|---|---|
| `src/include/switch_types.h` | `switch_rtp_numbers_t`, after `struct error_period *error_log;` (line 727) | Append 9 public stat fields |
| `src/switch_rtp.c` | `struct switch_rtp`, after `uint32_t prev_nacks_inflight;` (line 493) | Append private tracker state |
| `src/switch_rtp.c` | Include block (lines 34-51) | Add the `SIOCGSTAMP` include, guarded |
| `src/switch_rtp.c` | New static functions right after `check_jitter()` ends (line 1797) | `qt_arrival_us`, `qt_epoch_totals`, `qt_start_epoch`, `qt_jitter`, `qt_track` |
| `src/switch_rtp.c` | `read_rtp_packet()`, after `rtp_session->stats.inbound.packet_count++;` (line 6393, the stats block outside the PROXY_MEDIA guard) | Call `qt_track()` |
| `src/switch_rtp.c` | Flush loop, after `rtp_session->stats.inbound.packet_count++;` (line 5773) | Call `qt_track()` (flushed packets DID arrive, so they are not loss) |
| `src/switch_core_media.c` | `set_stats()`, after `add_stat_double(stats->inbound.mos, "in_mos");` (line 1883) | Export the new variables (AUDIO only) |

Appending to `switch_rtp_numbers_t` changes the layout of `switch_rtp_stats_t`. That is safe because every module is compiled from this same tree in the Dockerfile and no prebuilt binary modules are loaded. The FS agent must confirm this with `grep -rn switch_rtp_numbers_t src/mod` in the full pinned tree.

### A.2 Public fields (switch_types.h, appended)

```c
	/* ---- RCF quality patch v1 (docker/freeswitch/patches/0001) — additive ---- */
	switch_size_t seq_expected;      /* RFC 3550 A.1: sum over SSRC epochs of (ext_highest_seq - base_seq + 1) */
	switch_size_t seq_received;      /* packets counted by the tracker (in-order + late; exact dup of highest NOT counted) */
	switch_size_t seq_lost;          /* sum over epochs of max(0, expected - received). NEVER reset. */
	switch_size_t seq_loss_events;   /* forward sequence gaps (udelta > 1) = loss bursts */
	switch_size_t seq_reordered;     /* late (seq behind highest, within 100) + duplicates of highest */
	switch_size_t seq_epochs;        /* 1 + SSRC changes + sequence restarts (jump >= 3000) */
	double rfc3550_jitter_sum_ms;    /* sum of J (ms) over post-warmup samples */
	switch_size_t rfc3550_jitter_n;  /* number of post-warmup samples */
	double rfc3550_jitter_max_ms;    /* max J (ms) over post-warmup samples */
	uint8_t rfc3550_kernel_clock;    /* 1 = arrivals timed by SIOCGSTAMP (set in qt_jitter from qt_kernel_ts) */
```

These are 10 fields in total. `qt_jitter()` sets `rtp_session->stats.inbound.rfc3550_kernel_clock = rtp_session->qt_kernel_ts;` right after `qt_arrival_us()`.

### A.3 Private state (struct switch_rtp, appended)

```c
	/* ---- RCF quality patch v1 — tracker state for the current SSRC epoch ---- */
	uint8_t  qt_init;               /* an epoch is open */
	uint32_t qt_ssrc;
	uint16_t qt_base_seq;
	uint16_t qt_max_seq;
	uint32_t qt_cycles;             /* 65536 * wraps */
	uint64_t qt_ep_received;
	uint64_t qt_cl_expected, qt_cl_received, qt_cl_lost;   /* closed-epoch totals */
	uint8_t  qt_have_prev;
	int64_t  qt_prev_arrival_us;
	uint32_t qt_prev_ts;
	double   qt_jitter_us;          /* RFC 3550 J, microseconds */
	uint32_t qt_ep_jitter_samples;
	uint8_t  qt_kernel_ts;          /* 1 = last arrival came from SIOCGSTAMP */
```

The rtp_session memory comes from `switch_core_alloc` (pool memory, zero-filled), so no init code is needed. Add an explicit `memset` of the qt_* fields to `switch_rtp_create()` only if the FS agent finds the allocation is not zeroed.

### A.4 Tracker (switch_rtp.c, after check_jitter)

Guard the include:

```c
#if defined(__linux__)
#include <sys/ioctl.h>
#include <linux/sockios.h>
#endif
```

Functions:

```c
#define QT_MAX_DROPOUT   3000
#define QT_MAX_MISORDER  100
#define QT_JITTER_WARMUP 50     /* ~1 s at 20 ms: J starts at 0 and media start is noisy */

/* Kernel receive timestamp of the last packet read from sock_input (Linux SIOCGSTAMP);
 * falls back to switch_micro_time_now(). Arrival must be wire time, not read time:
 * FS reads are timer-paced (rtp_common_read), so read time is quantized to ptime. */
static int64_t qt_arrival_us(switch_rtp_t *rtp_session)
{
#if defined(__linux__) && defined(SIOCGSTAMP)
	switch_os_socket_t fd = SWITCH_SOCK_INVALID;
	struct timeval tv;
	if (switch_os_sock_get(&fd, rtp_session->sock_input) == SWITCH_STATUS_SUCCESS && fd != SWITCH_SOCK_INVALID
		&& ioctl(fd, SIOCGSTAMP, &tv) == 0) {
		rtp_session->qt_kernel_ts = 1;
		return (int64_t)tv.tv_sec * 1000000 + tv.tv_usec;
	}
#endif
	rtp_session->qt_kernel_ts = 0;
	return (int64_t)switch_micro_time_now();
}

static void qt_epoch_totals(switch_rtp_t *rtp_session)
{
	int64_t exp  = (int64_t)rtp_session->qt_cycles + rtp_session->qt_max_seq - rtp_session->qt_base_seq + 1;
	int64_t lost = exp - (int64_t)rtp_session->qt_ep_received;
	if (lost < 0) lost = 0;
	rtp_session->stats.inbound.seq_expected = (switch_size_t)(rtp_session->qt_cl_expected + (uint64_t)exp);
	rtp_session->stats.inbound.seq_received = (switch_size_t)(rtp_session->qt_cl_received + rtp_session->qt_ep_received);
	rtp_session->stats.inbound.seq_lost     = (switch_size_t)(rtp_session->qt_cl_lost + (uint64_t)lost);
}

static void qt_start_epoch(switch_rtp_t *rtp_session, uint16_t seq, uint32_t ssrc)
{
	if (rtp_session->qt_init) {            /* freeze the running epoch into the closed totals */
		rtp_session->qt_cl_expected = rtp_session->stats.inbound.seq_expected;
		rtp_session->qt_cl_received = rtp_session->stats.inbound.seq_received;
		rtp_session->qt_cl_lost     = rtp_session->stats.inbound.seq_lost;
	}
	rtp_session->qt_init = 1;
	rtp_session->qt_ssrc = ssrc;
	rtp_session->qt_base_seq = rtp_session->qt_max_seq = seq;
	rtp_session->qt_cycles = 0;
	rtp_session->qt_ep_received = 1;
	rtp_session->qt_have_prev = 0;
	rtp_session->qt_jitter_us = 0;
	rtp_session->qt_ep_jitter_samples = 0;
	rtp_session->stats.inbound.seq_epochs++;
	qt_epoch_totals(rtp_session);
}

static void qt_jitter(switch_rtp_t *rtp_session, uint32_t ts, uint8_t pt)
{
	int64_t now;
	if (rtp_session->samples_per_second != 8000) return;   /* 8 kHz RTP clock only (PCMU/PCMA/G729/G722-rtp) */
	if (pt == rtp_session->recv_te) return;                 /* RFC 2833 ts = event start, not a media clock */
	now = qt_arrival_us(rtp_session);
	if (rtp_session->qt_have_prev) {
		int64_t d_arr = now - rtp_session->qt_prev_arrival_us;
		int64_t d_ts  = (int64_t)(int32_t)(ts - rtp_session->qt_prev_ts) * 125;   /* 1e6/8000 us per tick */
		double  D     = (double)(d_arr - d_ts);
		if (D < 0) D = -D;
		rtp_session->qt_jitter_us += (D - rtp_session->qt_jitter_us) / 16.0;      /* RFC 3550 6.4.1 */
		if (++rtp_session->qt_ep_jitter_samples > QT_JITTER_WARMUP) {
			double j_ms = rtp_session->qt_jitter_us / 1000.0;
			rtp_session->stats.inbound.rfc3550_jitter_sum_ms += j_ms;
			rtp_session->stats.inbound.rfc3550_jitter_n++;
			if (j_ms > rtp_session->stats.inbound.rfc3550_jitter_max_ms) rtp_session->stats.inbound.rfc3550_jitter_max_ms = j_ms;
		}
	}
	rtp_session->qt_prev_arrival_us = now;
	rtp_session->qt_prev_ts = ts;
	rtp_session->qt_have_prev = 1;
}

/* Called once per RTP packet read off the audio socket (any PT of the stream: audio, CN, RFC 2833).
 * Pure bookkeeping — never alters the packet, flags, flaws, mos or any existing stat. */
static void qt_track(switch_rtp_t *rtp_session, uint16_t seq, uint32_t ts, uint32_t ssrc, uint8_t pt)
{
	uint16_t udelta;
	if (rtp_session->flags[SWITCH_RTP_FLAG_VIDEO] || rtp_session->flags[SWITCH_RTP_FLAG_TEXT] ||
		rtp_session->flags[SWITCH_RTP_FLAG_UDPTL]) return;
	if (!rtp_session->qt_init || ssrc != rtp_session->qt_ssrc) {        /* new source = new epoch, not loss */
		qt_start_epoch(rtp_session, seq, ssrc);
		qt_jitter(rtp_session, ts, pt);
		return;
	}
	udelta = (uint16_t)(seq - rtp_session->qt_max_seq);
	if (udelta == 0) {                                                  /* duplicate of highest */
		rtp_session->stats.inbound.seq_reordered++;
		return;
	} else if (udelta < QT_MAX_DROPOUT) {                               /* in order, maybe after a gap */
		if (seq < rtp_session->qt_max_seq) rtp_session->qt_cycles += 65536;
		if (udelta > 1) rtp_session->stats.inbound.seq_loss_events++;
		rtp_session->qt_max_seq = seq;
		rtp_session->qt_ep_received++;
		qt_jitter(rtp_session, ts, pt);
	} else if (udelta <= (uint16_t)(65536 - QT_MAX_MISORDER)) {         /* sender restart / huge jump */
		qt_start_epoch(rtp_session, seq, ssrc);
		qt_jitter(rtp_session, ts, pt);
		return;
	} else {                                                            /* late: fills an earlier gap */
		rtp_session->qt_ep_received++;
		rtp_session->stats.inbound.seq_reordered++;
	}
	qt_epoch_totals(rtp_session);
}
```

**Call sites.**

(1) In `read_rtp_packet()` after line 6393:
```c
if (rtp_session->has_rtp && *bytes > rtp_header_len) qt_track(rtp_session, ntohs(rtp_session->last_rtp_hdr.seq), ntohl(rtp_session->last_rtp_hdr.ts), ntohl(rtp_session->last_rtp_hdr.ssrc), rtp_session->last_rtp_hdr.pt);
```
Before writing this, confirm in the full tree that this block runs after SRTP unprotect (SRTP-failed packets `goto more` and are not counted) and is outside the `!PROXY_MEDIA` guard (so trunk calls, which set `proxy_media=true`, are measured).

(2) In the flush loop after line 5773:
```c
if (bytes > rtp_header_len && rtp_session->recv_msg.header.version == 2) qt_track(rtp_session, ntohs(rtp_session->recv_msg.header.seq), ntohl(rtp_session->recv_msg.header.ts), ntohl(rtp_session->recv_msg.header.ssrc), rtp_session->recv_msg.header.pt);
```

**Semantics, stated plainly.**
- `seq_lost` counts packets that never reached FS's socket-read stage. That is network loss, plus packets dropped by the pre-count "already sent this frame" check at line 6243 (a late packet FS had already covered with CNG, which is effective loss).
- Autoflush-discarded packets are counted as received. FS's own discard is visible separately in the existing `in_flush_packet_count` / `in_skip_packet_count`.
- DTX, hold and silence gaps create no loss, because seq continues contiguously.
- RFC 2833 and CN packets share the seq space and are counted, so DTMF never creates false loss (fixes the DTMF-reset finding).
- SSRC changes and seq jumps start a new epoch instead of creating loss (fixes the SSRC/seq-jump finding).
- The epoch restart is a simplification of RFC 3550 A.1's two-packet probation. A single stray packet costs at most 1 packet of accounting. That is accepted and documented.

**Why not the alternatives:**
- `stats.rtcp.inter_jitter` uses `timer.samplecount` as its arrival clock (switch_rtp.c:2008), which is quantized to the 20 ms tick. It also resets on every SSRC change.
- `stats.inbound.std_deviation` (set in switch_core_media.c:1864) is the standard deviation of ms-granular read-time inter-arrival. It is poisoned by DTX/hold gaps (a 5 s gap adds 25,000,000 ms² to the running sum) and by 1 ms quantization.

Neither is exported by this patch. The existing `in_jitter_min/max_variance` exports stay as they are.

**Cost:** about 20 integer operations plus one `ioctl(SIOCGSTAMP)` per audio packet. The first `SIOCGSTAMP` enables `SOCK_TIMESTAMP` on the socket. At today's concurrency this is negligible. The 8K-concurrency upgrade review (NATIONWIDE plan) must re-measure it.

### A.5 Export (switch_core_media.c `set_stats`, AUDIO only)

```c
		if (type == SWITCH_MEDIA_TYPE_AUDIO) {
			switch_channel_set_variable(channel, "rtp_audio_in_qpatch", "1");
			add_stat(stats->inbound.seq_expected,    "in_seq_expected");
			add_stat(stats->inbound.seq_received,    "in_seq_received");
			add_stat(stats->inbound.seq_lost,        "in_seq_lost");
			add_stat(stats->inbound.seq_loss_events, "in_seq_loss_events");
			add_stat(stats->inbound.seq_reordered,   "in_seq_reordered");
			add_stat(stats->inbound.seq_epochs,      "in_seq_epochs");
			if (stats->inbound.rfc3550_jitter_n > 0) {
				add_stat_double(stats->inbound.rfc3550_jitter_sum_ms / (double)stats->inbound.rfc3550_jitter_n, "in_rfc3550_jitter_avg_ms");
				add_stat_double(stats->inbound.rfc3550_jitter_max_ms, "in_rfc3550_jitter_max_ms");
			}
		}
```

`set_stats` cannot read the private `qt_kernel_ts` flag, so it exports the public mirror `rfc3550_kernel_clock` (A.2) inside the same AUDIO block:

```c
switch_channel_set_variable(channel, "rtp_audio_in_rfc3550_clock", stats->inbound.rfc3550_kernel_clock ? "kernel" : "read");
```

**Resulting channel variables.** These are the contract with the API. All are strings, as FS does.

| Variable | Type / unit | Present when |
|---|---|---|
| `rtp_audio_in_qpatch` | `"1"` | patched image + audio media handle |
| `rtp_audio_in_seq_expected` | uint, packets | patched |
| `rtp_audio_in_seq_received` | uint, packets | patched |
| `rtp_audio_in_seq_lost` | uint, packets | patched |
| `rtp_audio_in_seq_loss_events` | uint, gaps | patched |
| `rtp_audio_in_seq_reordered` | uint, packets | patched |
| `rtp_audio_in_seq_epochs` | uint (0 = no RTP ever) | patched |
| `rtp_audio_in_rfc3550_jitter_avg_ms` | "%0.2f" ms | patched AND ≥ 51 in-order samples at 8 kHz |
| `rtp_audio_in_rfc3550_jitter_max_ms` | "%0.2f" ms | same |
| `rtp_audio_in_rfc3550_clock` | `kernel` / `read` | patched |

**Absence = old image.** The API treats a missing `rtp_audio_in_qpatch` as "legacy FS" (see B.3). All existing `rtp_audio_in_*` variables keep their exact names, formats and values. The patch touches none of `flaws`, `R`, `mos`, `recved`, `loss[]`, `lossrate`, `burstrate` or the variance fields.

### A.6 Dockerfile

After the FreeSWITCH checkout (current line 101), add:

```dockerfile
# RCF quality patch set — pinned-commit-specific; `git apply --check` fails the build loudly if FREESWITCH_REF moves.
COPY patches/ /usr/src/fs-patches/
RUN cd /usr/src/freeswitch && for p in /usr/src/fs-patches/*.patch; do git apply --check "$p" && git apply "$p" && echo "applied $p"; done
```

Add a comment above it: `0001-rcf-rtp-quality-v1.patch` is valid only for 0a54a48. On a ref bump, regenerate and re-verify it (lab §G.3). Build context is `./docker/freeswitch` (docker-compose.media.yml:16), so `patches/` sits beside the Dockerfile.

Generate the patch from a full pinned clone in the scratchpad. The scratch `fs/src` copy is only a partial tree:

```
git init fsfull && git -C fsfull fetch --depth 1 https://github.com/signalwire/freeswitch.git 0a54a48f3762ddb7ac9c263b7800f6da09fda3dd && git -C fsfull checkout FETCH_HEAD
```

Edit, then run `git -C fsfull diff > docker/freeswitch/patches/0001-rcf-rtp-quality-v1.patch`. Paths must be `a/src/...` so that `git apply` works from `/usr/src/freeswitch`. `switch_os_sock_get` / `SWITCH_SOCK_INVALID` must be verified in the full tree (`src/switch_apr.c`, `src/include/switch_apr.h`). If the names differ, use the tree's accessor. The contract is behaviour, not those identifiers.

### A.7 Stale-doc fixes (FS agent, comment-only)

- **`conf/sofia/internal.xml:268-283`:** The claim that RTCP must be enabled or "check_jitter()/estimate_mos() never runs" is false. `check_jitter` runs on the read path regardless of RTCP (switch_rtp.c:6046/6524/6563). `rtcp-audio-interval-msec` only drives `rtcp_stats()`/RTCP reports. Rewrite the comment to say that, and point at this plan for the patched variables.
- **`conf/sofia/external.xml:~180-190`:** "json_cdr has cdr-leg=a, so ONLY the internal/A-leg quality vars land in the CDR" is false. `log-b-leg=true` has been live since 2026-09-24 (json_cdr.conf.xml:114-133), and B-leg quality now lands in `leg='B'` rows and feeds `call_quality_*`.
- **`scripts/inbound_router.lua:1171-1214`:** The RCF path does NOT set `proxy_media`. It runs in default media mode (root CLAUDE.md "No proxy_media in RCF path"). Only the trunk terminator sets it (line 1966). Rewrite the header block to "Media handling: default media mode (FS decodes/relays; no proxy_media, no bypass)". Keep the bypass_media rationale and drop the proxy_media rationale. **Comment-only. Zero Lua logic change.** Run the Lua harnesses to prove it.
- `docker/freeswitch/CLAUDE.md` and `conf/CLAUDE.md`: add a "Quality patch v1" section (variable table from A.5, lab command, rebuild rule).

---

## B. Ingest + schema (API/DB agent)

There is **no `services/cdr_extract.py`** in this tree. Extraction lives in `routers/cdrs.py::_extract_quality_metrics`, which becomes a thin caller of the new pure module `docker/api/src/services/call_quality.py`.

### B.1 The model (services/call_quality.py) — exact formulas

```
R0            = 93.2          # G.107 default Ro - Is with all default parameters (T=Ta=Tr=0)
ID            = 0.0           # delay impairment: no mouth-to-ear delay measurement exists on this path
                              # (RTCP RTT at FS covers one segment only); G.107 default T=0 -> Id≈0. Named constant.
A             = 0             # advantage factor
CODEC_PARAMS  = {"PCMU": (0.0, 25.1), "PCMA": (0.0, 25.1), "G729": (11.0, 19.0)}   # (Ie, Bpl) G.113 App. I
DEFAULT_CODEC = (0.0, 25.1)   # unknown codec -> G.711 params (logged once per codec name)
BURST_R_MIN, BURST_R_MAX = 1.0, 10.0

Ppl   = loss_pct clamped to [0, 100]                  # percent
BurstR= clamp(burst_r or 1.0, 1.0, 10.0)
Ie_eff= Ie + (95 - Ie) * Ppl / (Ppl / BurstR + Bpl)   # G.107 (7-29)
R     = clamp(R0 - ID - Ie_eff + A, 0, 100)
MOS   = 1.0                                   if R <= 0
        4.5                                   if R >= 100
        1 + 0.035*R + 7e-6*R*(R-60)*(100-R)   otherwise          # G.107 Annex B
r_factor = round_half_up(R, 2);  mos = round_half_up(MOS(R_unrounded), 2)
```

Codec key = upper(`rtp_use_codec_name`), falling back to upper(`read_codec`).

**Why Bpl = 25.1 (G.711 with PLC) and not 4.3 (no PLC).** In default media mode FS forwards bridged audio frame by frame, and it does *not* forward CNG frames that stand in for a missing packet (`switch_ivr_bridge.c:803-811`, `continue` on `SFF_CNG`). FS itself therefore never conceals loss. The gap reaches the far-end receiver as a jitter-buffer underrun, and every carrier media gateway and handset conceals that with G.711 Appendix I-class PLC. Bpl=25.1 models that. The sensitivity is stated here so nobody is surprised: at 1% random loss Bpl 25.1 gives MOS 4.33 and Bpl 4.3 gives 3.83. Bpl is a named constant, and changing it is a one-line change plus a history re-run (B.6).

Reference points at BurstR = 1 (these are asserted in tests):

| loss % | 0 | 0.5 | 1 | 2 | 3 | 5 | 8 | 10 | 20 |
|---|---|---|---|---|---|---|---|---|---|
| R | 93.20 | 91.34 | 89.56 | 86.19 | 83.06 | 77.42 | 70.24 | 66.13 | 51.07 |
| MOS | 4.41 | 4.37 | 4.33 | 4.23 | 4.13 | 3.92 | 3.61 | 3.41 | 2.63 |

A perfectly clean G.711 call is **4.41**, not 4.50. That is the G.107 ceiling for G.711 at default delay.

**BurstR (patched only):**

```
if lost > 0 and loss_events > 0 and expected > 0:
    p = lost / expected
    burst_r = (lost / loss_events) * (1 - p)
else:
    burst_r = 1.0
```

This is the G.107 definition: mean observed burst length ÷ mean burst length under random loss, 1/(1-p). The result is clamped to [1, 10]. The lower clamp is deliberate. Reorder can inflate `loss_events`, and quality must never be overstated.

**Legacy (unpatched image or history):** `burst_r = 1.0`. We do not use FS `burstrate`: `burstr_calculate` divides a burst-*index*-weighted sum by the packet sum, so it never reflects multi-packet gaps.

### B.2 Rating rule — exact, per leg (A row and B row alike)

Inputs:
- `answered` = the leg's `answer_time` is not NULL.
- `billable_ms` = the leg's billsec in ms.
- `in_packets` = `rtp_audio_in_packet_count`. This counts all inbound RTP including CN, DTMF and flushed packets. NULL means the variable is absent.
- `ptime_ms` = int(`rtp_use_codec_ptime`) if 10 ≤ x ≤ 120, else 20.

Constants:

```
MIN_TALK_MS = 5000
MIN_PACKETS = 250
NO_RTP_RATIO = 0.10
expected_by_time = billable_ms / ptime_ms
```

Evaluate in this order; the first match wins:

| # | Condition | `quality_status` | `quality_grade` |
|---|---|---|---|
| 1 | not answered | `unanswered` | NULL |
| 2 | `in_packets` is NULL | `no_data` | NULL |
| 3 | `billable_ms < 5000` | `short` | NULL |
| 4 | `in_packets < 0.10 * expected_by_time` AND `out_packets >= 0.50 * expected_by_time` (since 51) | `no_rtp` | `poor` |
| 4b | `in_packets < 0.10 * expected_by_time` AND (`out_packets < 0.50 * expected_by_time` OR `out_packets` NULL) (since 51) | `no_media` | NULL |
| 5 | `in_packets < 250` | `low_sample` | NULL |
| 6 | loss input unavailable (patched: `seq_expected` missing/0; legacy: `rtp_audio_in_jitter_loss_rate` absent) | `no_data` | NULL |
| 7 | otherwise | `rated` | `cq_grade(mos)` |

The same rule is implemented in SQL as `cq_leg_status()` (B.4). Rule 6 is applied by the caller.

Against production facts:
- The three 0-1 s answered-then-hung-up calls fall under rule 3 (`short`, not graded).
- The 11 s Sinch call with 0 received / 591 sent packets falls under rule 4 (`no_rtp`, poor).
- The 17 unanswered calls fall under rule 1 (`unanswered`, MOS NULL).

**Known limit, documented:** `in_packets` includes pre-answer early media. A leg whose audio died after answer, but which had long early media, can escape `no_rtp`. The Grafana `inbound_media_ratio` distribution panel (E.1 #22) exposes those.

**Addendum — migration 51 (2026-09-24, owner-approved): `no_rtp` vs `no_media`.**
The migration-50 backfill marked 485 legs `no_rtp`. 479 of them (week of 2026-07-20, the load-test / rollout week) had `rtp_audio_in_packet_count = 0` AND `rtp_audio_out_packet_count = 0` — no media in EITHER direction (failed / test calls), not one-way audio. One 902 s call had 1863 packets in / 397 out (in ratio 0.041, out 0.009): both sides quiet (hold / DTX). The 5 genuine one-way cases had 2–134 packets in and 613–2204 out. Rule 4 therefore now also looks at the leg's outbound count, on the SAME expected basis:
- `out_packets` = `rtp_audio_out_packet_count` (NULL = unknown).
- constants (ONE place: `services/call_quality.py`; SQL mirrors the literals): `NO_RTP_RATIO = 0.10`, `ONE_WAY_MIN_OUT_RATIO = 0.50`.
- rule 4 → `no_rtp` (TRUE one-way: we sent audio, received none): graded `poor`, MOS NULL — unchanged semantics.
- rule 4b → `no_media` ("no audio either way — the call never carried media: failed setup, test call, or both parties silent"): **not graded** (grade NULL, MOS NULL), excluded from every one-way count (Grafana #11 / #22 / #30 / noc-home #33, SLI 2 numerator), lands in "Not graded", and never pages (`media_guard.sh` counts `no_rtp` only). `inbound_media_ratio` is still written (B.3).
- SQL: new overload `cq_leg_status(bool, int, int, int, int)` in `docker/postgres/init/51_cdr_quality_no_media.sql`; the 4-argument migration-50 function is kept unchanged (the inbound-only gate, still used by the 50 backfill). `cdr_refresh_call_quality()` needs no change: a `no_media` leg has no grade (never the worse direction), is not `no_rtp` (never makes the call one-way) and is not `rated`; a `no_media` A with no graded B gives `call_quality_status = 'no_media'`.
- History: `docker/postgres/backfill/51_reclassify_no_media.psql` converts stored `no_rtp` legs whose outbound count says no media either way, then re-runs `cdr_refresh_call_quality()` for every affected call (snapshot-first, exact rollback in its header, idempotent). Expected on production: ~480 legs reclassified, ~5 stay `no_rtp`.
- UI: customer reason "No audio either way — the call never carried sound"; staff "No media either direction (in < 10%, out < 50% of expected packets) — not graded".

### B.3 Column semantics after this change (every value the API writes)

"Rated-only" means: non-NULL only when `quality_status='rated'`, otherwise NULL.

| Column | Type | Written by the new API | Source |
|---|---|---|---|
| `mos` (existing) | NUMERIC(3,2) | our E-model MOS, rated-only | B.1 |
| `r_factor` (existing) | NUMERIC(5,2) | our G.107 R, rated-only | B.1 |
| `packet_loss_pct` (existing) | NUMERIC(5,2) | true loss %, rated-only | patched: `100*seq_lost/seq_expected`; legacy: `100*rtp_audio_in_jitter_loss_rate` (FS `lossrate` is a **fraction** 0..1, burstr_calculate `lost/received`; the implementer confirms against one prod row) |
| `packet_loss_count` (existing) | INTEGER | lost packets, rated-only | patched: `seq_lost`; legacy: `round(loss_rate * in_packets)` (estimate) |
| `jitter_avg_ms` (existing) | NUMERIC(8,3) | RFC 3550 per-call mean J, rated-only | `rtp_audio_in_rfc3550_jitter_avg_ms`; legacy: **NULL** (never fabricated) |
| `jitter_max_ms` (existing) | NUMERIC(8,3) | RFC 3550 post-warmup peak J, rated-only | `..._rfc3550_jitter_max_ms`; legacy NULL |
| `jitter_min_ms` (existing) | NUMERIC(8,3) | **always NULL** (deprecated) | — |
| `quality_pct` (existing) | NUMERIC(5,2) | **always NULL** (deprecated) | raw goes to `fs_quality_pct` |
| `flaw_total`, `packet_total_count`, `rtp_audio_in_*` bytes/counts, `rtp_audio_in_jitter_burst_rate/_loss_rate/_mean_interval` (existing) | as-is | **unchanged raw**, always when present | FS |
| `quality_status` NEW | VARCHAR(12) | always (never NULL from the new API) | B.2 |
| `quality_grade` NEW | VARCHAR(5) | `great/good/fair/poor` per B.2, else NULL | D |
| `quality_source` NEW | VARCHAR(16) | always: `fs_patch_v1` (qpatch=1 and seq vars parse) or `fs_legacy` | presence of A.5 variables |
| `fs_mos` NEW | NUMERIC(3,2) | raw `rtp_audio_in_mos`, when present | traceability |
| `fs_quality_pct` NEW | NUMERIC(5,2) | raw `rtp_audio_in_quality_percentage` | traceability |
| `fs_jitter_max_std_ms` NEW | NUMERIC(8,3) | sqrt(`rtp_audio_in_jitter_max_variance`) (the old `jitter_max_ms` meaning) | traceability |
| `rtp_audio_in_skip_packet_count` NEW | INTEGER | raw `rtp_audio_in_skip_packet_count` (the old `packet_loss_count` meaning, CNG/autoflush) | raw |
| `packets_expected` NEW | INTEGER | `seq_expected`, patched, any status | raw |
| `loss_bursts` NEW | INTEGER | `seq_loss_events`, patched, any status | raw |
| `packets_reordered` NEW | INTEGER | `seq_reordered`, patched, any status | raw |
| `ssrc_changes` NEW | SMALLINT | `max(seq_epochs - 1, 0)`, patched, any status | raw |
| `burst_ratio` NEW | NUMERIC(6,3) | BurstR used in the model, rated-only | B.1 |
| `inbound_media_ratio` NEW | NUMERIC(6,3) | `min(in_packets / expected_by_time, 999.999)` for statuses `rated/no_rtp/low_sample` (+ `no_media` since 51), else NULL | B.2 |
| `call_quality_status` NEW (A rows) | VARCHAR(12) | set by `cdr_refresh_call_quality()` only | C |
| `call_quality_grade` NEW (A rows) | VARCHAR(5) | same | C |
| `call_mos` NEW (A rows) | NUMERIC(3,2) | same | C |
| `call_quality_leg` NEW (A rows) | VARCHAR(1) `A`/`B` | same (staff-only) | C |

NULL vs 0:
- `0` means "measured zero", for example `packet_loss_pct=0.00` on a rated clean call, or `packets_expected=0` on a patched leg that never got RTP.
- `NULL` means "not measured or not meaningful".
- A failure in `_extract_quality_metrics` keeps the existing contract: the whole quality set becomes NULL, and `quality_status` becomes `no_data`, never NULL.
- Every value is parsed defensively and clamped to its column bounds, as the existing `_clamped_*` helpers do.

### B.4 Migration `docker/postgres/init/50_cdr_quality_accuracy.sql`

This is a plain SQL file, idempotent and replayable. Appending it to `tests/cdr_schema.py::CDR_COLUMN_MIGRATIONS` is allowed; add a note that its only non-cdrs objects are `CREATE OR REPLACE FUNCTION`s.

It uses the same form as 47/48: `ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS …` for the 17 NEW columns in B.3, **no DEFAULT, no CHECK, no index**. ADD COLUMN without a default is metadata-only on compressed hypertables. Also add `COMMENT ON COLUMN` for every new column and for the changed meaning of `mos`, `r_factor`, `packet_loss_pct`, `packet_loss_count`, `jitter_avg_ms`, `jitter_max_ms`, `jitter_min_ms` and `quality_pct`.

Functions (all `LANGUAGE sql`; the first four are `IMMUTABLE PARALLEL SAFE`; float8 arithmetic in the same operation order as Python):

```sql
CREATE OR REPLACE FUNCTION cq_r_factor(p_loss_pct float8, p_burst_r float8, p_ie float8 DEFAULT 0, p_bpl float8 DEFAULT 25.1)
RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_loss_pct IS NULL THEN NULL ELSE
    GREATEST(0::float8, LEAST(100::float8,
      93.2 - 0.0 - (p_ie + (95 - p_ie) * LEAST(GREATEST(p_loss_pct,0),100)
                  / (LEAST(GREATEST(p_loss_pct,0),100) / LEAST(GREATEST(COALESCE(p_burst_r,1),1),10) + p_bpl))))
  END $$;

CREATE OR REPLACE FUNCTION cq_mos(p_r float8) RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_r IS NULL THEN NULL WHEN p_r <= 0 THEN 1.0 WHEN p_r >= 100 THEN 4.5
              ELSE 1 + 0.035*p_r + 0.000007*p_r*(p_r-60)*(100-p_r) END $$;

CREATE OR REPLACE FUNCTION cq_grade(p_mos numeric) RETURNS varchar LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_mos IS NULL THEN NULL WHEN p_mos >= 4.34 THEN 'great' WHEN p_mos >= 4.02 THEN 'good'
              WHEN p_mos >= 3.60 THEN 'fair' ELSE 'poor' END $$;       -- input = the STORED 2-dp mos

CREATE OR REPLACE FUNCTION cq_grade_rank(p_grade varchar) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_grade WHEN 'poor' THEN 0 WHEN 'fair' THEN 1 WHEN 'good' THEN 2 WHEN 'great' THEN 3 END $$;

CREATE OR REPLACE FUNCTION cq_leg_status(p_answered bool, p_billable_ms int, p_in_packets int, p_ptime_ms int DEFAULT 20)
RETURNS varchar LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN NOT p_answered THEN 'unanswered'
              WHEN p_in_packets IS NULL THEN 'no_data'
              WHEN COALESCE(p_billable_ms,0) < 5000 THEN 'short'
              WHEN p_in_packets < 0.10 * p_billable_ms::float8 / p_ptime_ms THEN 'no_rtp'
              WHEN p_in_packets < 250 THEN 'low_sample'
              ELSE 'rated' END $$;
```

Rounding rule used by both SQL and Python: `round(x::numeric, 2)` in SQL, and `Decimal(repr(x)).quantize(Decimal("0.01"), ROUND_HALF_UP)` in Python.

**Call-level combine.** The function is VOLATILE and returns the number of A rows updated (0 or 1):

```sql
CREATE OR REPLACE FUNCTION cdr_refresh_call_quality(p_call_id varchar, p_anchor timestamptz)
RETURNS int LANGUAGE sql AS $$
WITH a AS (
  SELECT id, uuid, start_time, end_time, quality_status, quality_grade, mos
    FROM cdrs
   WHERE uuid = p_call_id AND leg IS DISTINCT FROM 'B'
     AND start_time >= p_anchor - interval '1 day' AND start_time <= p_anchor + interval '1 minute'
   LIMIT 1
), b AS (
  SELECT c.quality_status, c.quality_grade, c.mos
    FROM cdrs c JOIN a ON c.call_id = a.uuid
   WHERE c.leg = 'B' AND c.answer_time IS NOT NULL
     AND c.start_time >= a.start_time AND c.start_time <= a.end_time + interval '1 minute'
   ORDER BY c.leg_attempt DESC NULLS LAST, c.start_time DESC
   LIMIT 1
), legs AS (
  SELECT 'A'::varchar AS leg, quality_status, quality_grade, mos FROM a
  UNION ALL
  SELECT 'B', quality_status, quality_grade, mos FROM b
), w AS (
  SELECT leg, quality_grade FROM legs WHERE quality_grade IS NOT NULL
   ORDER BY cq_grade_rank(quality_grade), (quality_status = 'no_rtp') DESC, mos ASC NULLS LAST, leg
   LIMIT 1
), agg AS (
  SELECT bool_or(quality_status = 'no_rtp') AS any_no_rtp,
         bool_or(quality_status = 'rated')  AS any_rated,
         min(mos) FILTER (WHERE quality_status = 'rated') AS min_rated_mos
    FROM legs
), upd AS (
  UPDATE cdrs t SET
      call_quality_grade  = (SELECT quality_grade FROM w),
      call_quality_leg    = (SELECT leg FROM w),
      call_quality_status = CASE WHEN agg.any_no_rtp THEN 'no_rtp' WHEN agg.any_rated THEN 'rated'
                                 ELSE a.quality_status END,
      call_mos            = CASE WHEN agg.any_no_rtp THEN NULL ELSE agg.min_rated_mos END
    FROM a, agg
   WHERE t.id = a.id AND t.start_time = a.start_time
  RETURNING 1
)
SELECT count(*)::int FROM upd $$;
```

Grants (role-guarded `DO` blocks, as in 48): `GRANT ALL ON cdrs TO api`, `GRANT SELECT ON cdrs TO grafana_ro`, and `GRANT EXECUTE ON FUNCTION cq_* , cdr_refresh_call_quality TO api` (plus `cq_*` to `grafana_ro`).

Apply on the East primary only. It replicates.

### B.5 Ingest changes (`routers/cdrs.py`)

1. **`_extract_quality_metrics(variables, *, answered: bool, billable_ms: int)`** returns every B.3 column except the `call_*` ones. Its caller already has `answer_time` and `billable_ms`. The ordering must change so that extraction runs after `billable_ms` is computed (it already does, at line ~1139). Delete `_compute_r_factor` (the MOS relabel). The logging `field_checks` dict gains the new keys.
2. **INSERT tier.** Append `$61..$73` in exactly this order:
   `quality_status ::varchar, quality_grade ::varchar, quality_source ::varchar, fs_mos ::numeric, fs_quality_pct ::numeric, fs_jitter_max_std_ms ::numeric, rtp_audio_in_skip_packet_count ::int, packets_expected ::int, loss_bursts ::int, packets_reordered ::int, ssrc_changes ::smallint, burst_ratio ::numeric, inbound_media_ratio ::numeric`.
   `_CDR_INSERT_PARAM_COUNT = 73`. The tiers become full (73) → pre-50 (60) → pre-48 (57) → pre-47 (55), each a strict tail truncation. Add a `_is_50_column()` detector like the 47/48 ones.
   B-leg rows may use the pre-50 tier, because they still carry `leg`; the pre-48 no-fallback rule for B rows stays.
   `db/schema_check.py::REQUIRED_CDR_COLUMNS` gets the 13 INSERT columns plus the 4 `call_*` columns → `50_cdr_quality_accuracy.sql`.
3. **Call-level refresh.** Both the A path (after `_execute_cdr_insert`, including on `duplicate`) and `_insert_b_leg_row` (after its insert) run:
   `SELECT cdr_refresh_call_quality($1::varchar, $2::timestamptz)` with `$1` = `call_id` (A uuid) and `$2` = this row's `start_time`.
   It must be its **own statement after the INSERT has committed**, never in the same transaction. That is what makes the ordering safe (C.2).
   On `UndefinedFunctionError` (migration 50 absent), log at ERROR, rate-limited, and continue. It must never affect the 200 contract.
4. **Read endpoints.**
   - Staff list (≈line 1908) and staff detail (≈line 2163) SELECT all new columns.
   - Float-ify `call_mos, burst_ratio, inbound_media_ratio, fs_mos, fs_quality_pct, fs_jitter_max_std_ms` alongside the existing `_FLOAT_KEYS` loop (line 2188).
   - Detail (staff AND tenant) adds `quality_by_direction` (C.3).

### B.6 Backfill `docker/postgres/backfill/50_cdr_quality_backfill.psql`

This is a new directory, deliberately outside `init/` so initdb never runs it (a fresh DB has no history).

It is a psql script: autocommit, no `-1`, `\set ON_ERROR_STOP on`.

- **Idempotent by construction.** It processes exactly `WHERE quality_source IS NULL`, which are the rows the old API wrote. The new API always writes `quality_source`, so no cutoff variable is needed.
- **Re-run safe.** It can be re-run after any rollback window; already-processed rows are skipped.
- **Ring-fenced.** It reads only stored columns and never touches billing/rating columns.

Steps:

0. Guards:
   - `\if` that `cdrs.quality_source` exists, else abort with a message.
   - When TimescaleDB is present: `SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0;`. The 2.26 default of 100k can abort a DML that decompresses a chunk; 0 = unlimited, which is safe at this volume.
1. **Snapshot for exact rollback:**
   `CREATE TABLE IF NOT EXISTS cdr_quality_backfill_50_snapshot (uuid varchar(64), start_time timestamptz, mos numeric(3,2), quality_pct numeric(5,2), r_factor numeric(5,2), packet_loss_pct numeric(5,2), packet_loss_count int, jitter_min_ms numeric(8,3), jitter_max_ms numeric(8,3), jitter_avg_ms numeric(8,3), PRIMARY KEY (uuid, start_time));`
   then `INSERT … SELECT … FROM cdrs WHERE quality_source IS NULL ON CONFLICT DO NOTHING;`
2. **Per-leg recompute, one UPDATE per chunk (autocommit each).**
   Generate the statements with
   `SELECT format($f$ …UPDATE… AND c.start_time >= %L AND c.start_time < %L $f$, range_start, range_end) FROM timescaledb_information.chunks WHERE hypertable_name='cdrs' ORDER BY range_start \gexec`.
   The `\else` branch for a non-Timescale test harness runs one unbounded UPDATE.
   UPDATE on compressed chunks is supported on TimescaleDB ≥ 2.11 (prod 2.26.3). It decompresses the touched batches, and the compression policy (1 day) recompresses them. The UPDATE body is:

```sql
WITH s AS (
  SELECT id, start_time,
         CASE WHEN st = 'rated' AND rtp_audio_in_jitter_loss_rate IS NULL THEN 'no_data' ELSE st END AS st,
         LEAST(GREATEST(rtp_audio_in_jitter_loss_rate::float8 * 100, 0), 100) AS lp,
         CASE upper(COALESCE(read_codec,'')) WHEN 'G729' THEN 11.0 ELSE 0.0 END AS ie,
         CASE upper(COALESCE(read_codec,'')) WHEN 'G729' THEN 19.0 ELSE 25.1 END AS bpl
    FROM (SELECT *, cq_leg_status(answer_time IS NOT NULL, billable_ms, rtp_audio_in_packet_count, 20) AS st
            FROM cdrs WHERE quality_source IS NULL AND start_time >= :lo AND start_time < :hi) x
)
UPDATE cdrs c SET
  fs_mos = c.mos, fs_quality_pct = c.quality_pct, fs_jitter_max_std_ms = c.jitter_max_ms,
  rtp_audio_in_skip_packet_count = c.packet_loss_count,
  quality_status = s.st,
  quality_source = 'backfill_v1',
  burst_ratio       = CASE WHEN s.st = 'rated' THEN 1.000 END,
  packet_loss_pct   = CASE WHEN s.st = 'rated' THEN round(s.lp::numeric, 2) END,
  packet_loss_count = CASE WHEN s.st = 'rated' THEN round(c.rtp_audio_in_jitter_loss_rate * c.rtp_audio_in_packet_count)::int END,
  r_factor          = CASE WHEN s.st = 'rated' THEN round(cq_r_factor(s.lp, 1, s.ie, s.bpl)::numeric, 2) END,
  mos               = CASE WHEN s.st = 'rated' THEN round(cq_mos(cq_r_factor(s.lp, 1, s.ie, s.bpl))::numeric, 2) END,
  quality_grade     = CASE WHEN s.st = 'rated' THEN cq_grade(round(cq_mos(cq_r_factor(s.lp, 1, s.ie, s.bpl))::numeric, 2))
                           WHEN s.st = 'no_rtp' THEN 'poor' END,
  inbound_media_ratio = CASE WHEN s.st IN ('rated','no_rtp','low_sample')
                             THEN LEAST(round(c.rtp_audio_in_packet_count::numeric / (c.billable_ms / 20.0), 3), 999.999) END,
  quality_pct = NULL, jitter_min_ms = NULL, jitter_max_ms = NULL, jitter_avg_ms = NULL
FROM s WHERE c.id = s.id AND c.start_time = s.start_time;
```

   The SET right-hand sides read the OLD row values, so the `fs_*` copies happen before the overwrite. `read_codec` stands in for `rtp_use_codec_name`, which history does not store, and history uses ptime 20.

3. **Call-level, per chunk.**
   `SELECT count(cdr_refresh_call_quality(uuid, start_time)) FROM cdrs WHERE leg IS DISTINCT FROM 'B' AND call_quality_status IS NULL AND quality_source IS NOT NULL AND start_time >= %L AND start_time < %L`, generated with `\gexec` the same way.
4. **Marker:** `INSERT INTO data_migrations (migration_id, notes) VALUES ('50_cdr_quality_backfill', 'E-model recompute of history from stored loss_rate') ON CONFLICT (migration_id) DO UPDATE SET applied_at = now();`. Use `CREATE TABLE IF NOT EXISTS data_migrations` exactly as in 43.
5. **Report:** `SELECT quality_source, quality_status, count(*) FROM cdrs GROUP BY 1,2 ORDER BY 1,2;`

**Yes, MOS is recomputed for history** from the stored `rtp_audio_in_jitter_loss_rate`, using the same legacy formula the live API applies to unpatched images. That makes history and legacy-image rows one consistent population (`quality_source` distinguishes them). Historical `jitter_avg/max/min` become NULL because they were fabricated or poisoned; the old peak is preserved in `fs_jitter_max_std_ms`. **Exact rollback** comes from `cdr_quality_backfill_50_snapshot` (H.3).

---

## C. Two-direction call quality (RCF)

### C.1 Definitions

- **A-in (caller→platform):** the A row's own `rtp_audio_in_*`. This is the caller's audio as FS received it, which is what the *callee* hears.
- **B-in (callee→platform):** the answered carrier B row (`leg='B'`, `call_id` = A uuid, `answer_time IS NOT NULL`; if more than one, the highest `leg_attempt`). This is what the *caller* hears.
- **Call quality = the worse direction.**
  - Choose the lowest `cq_grade_rank`.
  - On a tie, `no_rtp` wins, then the lower MOS, then A.
  - `call_quality_status` is `no_rtp` if either leg is `no_rtp`; else `rated` if either leg is `rated`; else the A status.
  - `call_mos` is the minimum MOS over rated legs, and NULL when the status is `no_rtp`.
- **No B row** (on-net terminal, trunk/API products, B-rows disabled, B not yet ingested): call quality = A quality.

### C.2 Where and when

The values are stored on the A row by `cdr_refresh_call_quality()` (B.4). They are not computed at query time, so every consumer (Grafana, reports, UI, CSV, Equinox) reads plain columns.

Ordering proof. A and B POST near-simultaneously in any order. Each ingest calls the refresh function *after its own INSERT has committed*.
- The ingest that commits second runs its refresh after both rows are committed, so under READ COMMITTED its statement sees both.
- The first ingest's refresh may see only its own row. That result is overwritten by the second.
- Concurrent refreshes serialize on the A row lock. The function is a deterministic function of committed rows, so the last writer is correct.
- Late disk re-ingest (`/ingest/bulk`, up to 3 days) re-runs the refresh, which is idempotent.

### C.3 Detail API shape — `quality_by_direction`

`GET /v1/cdrs/{uuid}` (staff and tenant) adds this block on A rows. On B rows it is `null`.

```json
"quality_by_direction": {
  "caller_audio": { "quality_status": "rated", "quality_grade": "great", "mos": 4.41, "r_factor": 93.2,
                    "packet_loss_pct": 0.0, "packet_loss_count": 0, "jitter_avg_ms": 1.9, "jitter_max_ms": 4.2,
                    "burst_ratio": 1.0, "inbound_media_ratio": 1.01 },
  "callee_audio": { ...same keys... } | null
}
```

- `caller_audio` = the A row.
- `callee_audio` = the answered carrier B row, or `null`.
- The staff shape also adds `uuid`, `quality_source`, `packets_expected`, `packets_reordered`, `ssrc_changes` and `fs_mos` inside each block.
- The tenant shape carries only the keys listed above. That makes it a derived, allowlisted key: add `quality_by_direction` to `TENANT_CDR_FIELDS`, and build the nested dicts from allowlisted columns only, never from raw rows.
- The key names `caller_audio` / `callee_audio` avoid the forbidden `leg` vocabulary.

---

## D. The ONE grade definition

The grade is derived from G.107 Annex B / G.109 user-satisfaction R bands and applied to the **stored 2-dp MOS**:

| Grade | R band (G.109) | MOS (R→MOS, 2 dp) | Loss at BurstR=1, G.711+PLC | UI tone |
|---|---|---|---|---|
| `great` | R ≥ 90 "very satisfied" | **≥ 4.34** | ≤ 0.87% | GOOD (green) |
| `good` | 80 ≤ R < 90 "satisfied" | **≥ 4.02** | ≤ 4.05% | GOOD (green) |
| `fair` | 70 ≤ R < 80 "some users dissatisfied" | **≥ 3.60** | ≤ 8.11% | WARN (amber) |
| `poor` | R < 70, or `quality_status='no_rtp'` | **< 3.60** | > 8.11% | BAD (red) |
| `none` (API/UI word) / NULL (DB) | not graded | — | — | INK_FAINT |

The MOS cut points are R=90/80/70 mapped to MOS and rounded to 2 dp (4.339→4.34, 4.024→4.02, 3.597→3.60). Grading on the rounded stored value means Python, SQL and TypeScript give identical answers for every stored row.

Secondary (colour-only) thresholds, used wherever a raw number is shown:
- R: ≥ 80 green, ≥ 70 amber, < 70 red.
- Loss %: ≤ 4 green, ≤ 8 amber, > 8 red. These are the good/fair loss boundaries above.
- Jitter (RFC 3550 mean): ≤ 20 ms green, ≤ 50 ms amber, > 50 ms red. This is diagnostic only; jitter does not enter the MOS because FS has no jitter buffer to observe discards.

Owners:
- `services/call_quality.py::grade_for_mos` (source of truth).
- SQL `cq_grade`.
- `services/reporting.py::grade_for_mos`, which delegates to call_quality.
- UI `pages/calls/quality.ts::gradeForMos`.
- Grafana literal thresholds 3.60/4.02/4.34.

---

## E. Every consumer

### E.1 Grafana (Grafana agent)

Common rules for every panel:
- Graded predicates only: leg-level panels use `quality_status = 'rated'` (plus `no_rtp` where stated); call-level panels use `leg IS DISTINCT FROM 'B' AND call_quality_grade IS NOT NULL`.
- Keep each panel's existing zone `CASE WHEN freeswitch_node …` predicate verbatim.
- No averages of MOS anywhere. Use shares and percentiles.

**`docker/homer/grafana/dashboards/noc/call-quality.json`:**

| id | New title | Query semantics |
|---|---|---|
| 43 | Good-or-better calls — last 15m (stat, %) | `100.0*count(*) FILTER (WHERE call_quality_grade IN ('great','good')) / NULLIF(count(*) FILTER (WHERE call_quality_grade IS NOT NULL),0)` over A rows, `start_time > now()-15m`. Thresholds: red < 90, amber < 97, green |
| 12 | Call MOS — p50 / p10 (10m) | `percentile_cont(0.5)` and `(0.1) WITHIN GROUP (ORDER BY call_mos)` WHERE `call_quality_status='rated' AND call_mos IS NOT NULL`. Y 1–4.5; threshold lines 3.60 / 4.02 / 4.34 |
| 21 | True packet loss — p95 by direction (10m) | Over `quality_status='rated'` rows: `percentile_cont(0.95) WITHIN GROUP (ORDER BY packet_loss_pct) FILTER (WHERE leg IS DISTINCT FROM 'B') AS "caller→platform p95"` and `… FILTER (WHERE leg='B') AS "callee→platform p95"` |
| 10 (row) | Quality detail — grades / loss / jitter / one-way audio (graded legs only) | — |
| 20 | Jitter (RFC 3550) — p50 / p95 by direction (10m) | `jitter_avg_ms` over `quality_status='rated' AND jitter_avg_ms IS NOT NULL`, split by leg as in #21. Description: empty until FS images are patched |
| 11 | Call grade distribution | Bands (fixed VALUES list, LEFT JOIN, as today): Great / Good / Fair / Poor (audio) = `call_quality_grade='poor' AND call_quality_status<>'no_rtp'` / One-way or no audio = `call_quality_status='no_rtp'`. A rows in range |
| 13 | Loss distribution — graded legs (barchart) | Bands over rated legs: `0`, `(0,0.5)`, `[0.5,1)`, `[1,2)`, `[2,4)`, `[4,8)`, `≥8` %. Replaces the R-factor trend |
| 22 | One-way / no inbound audio — per hour | `$__timeGroup(start_time,'1h')`, `count(*) FILTER (WHERE quality_status='no_rtp' AND leg IS DISTINCT FROM 'B') AS "caller→platform silent"` and `… leg='B' … "callee→platform silent"`. Replaces "Quality %". Add a second query: `count(*) FILTER (WHERE quality_status IN ('rated','low_sample') AND inbound_media_ratio < 0.5)` as "partial inbound media" |
| 30 | Graded-call quality snapshot (stat) | Graded calls = `count(call_quality_grade)`; Good+ %; Poor % (incl. one-way); p10 call MOS; One-way audio calls = `count(*) FILTER (WHERE call_quality_status='no_rtp')`; Not graded = `count(*) FILTER (WHERE call_quality_grade IS NULL)`. A rows, `$__timeFilter` |

All other panel ids (40-42, 44, 45, 1-4, 60-64, 70-76) are unchanged.

**`docker/homer/grafana/dashboards/noc/noc-home.json`:**

| id | New title | Query |
|---|---|---|
| 30 | Voice · Good+ calls — 15m | as call-quality #43 |
| 31 | Voice · Loss p95 — 15m | `percentile_cont(0.95) WITHIN GROUP (ORDER BY packet_loss_pct)` over `quality_status='rated'` (both legs), `start_time > now()-15m`; unit %; thresholds green ≤ 1, amber ≤ 4, red |
| 32 | Voice · Jitter p95 — 15m | same over `jitter_avg_ms`; thresholds 20 / 50 ms |
| 33 | Voice · One-way audio — 1h | `count(*) FROM cdrs WHERE leg IS DISTINCT FROM 'B' AND call_quality_status='no_rtp' AND start_time > now()-interval '1 hour'`; thresholds 0 green, ≥ 1 red |

The old ad-hoc gates `billable_ms >= 10000 AND rtp_audio_in_packet_count >= 500` are removed; `quality_status` replaces them.

**`traffic-status.json`:** no change. It has no CDR-quality panels (VictoriaMetrics real-time wall); verified by grep. The text panel mentions no MOS.

**`infra/monitoring/SLOS.md`:** add a "Voice quality SLI" section with these parts:
- SLI 1 = % of graded calls grade ≥ good, target 97% / 30 d.
- SLI 2 = one-way-audio calls per 1,000 answered ≥ 5 s, target ≤ 1.
- The exact SQL for both, the D table, and a note that MOS is E-model (G.107) from true sequence loss, with G.711 at 4.41 as the ceiling.

### E.2 Customer reports (API agent)

**`services/reporting.py`:**
- `grade_for_mos` delegates to `call_quality.grade_for_mos` (4.34 / 4.02 / 3.60).
- Update its docstring.
- `GRADE_LABELS` stays the same.

**`routers/reports.py`:**
- `_BASE_CTE` selects `c.call_mos AS mos, c.call_quality_grade AS grade`.
- Overview: `rated = count(*) FILTER (WHERE cur AND grade IS NOT NULL)`; `avg_mos = avg(mos) FILTER (WHERE cur AND grade IS NOT NULL AND mos IS NOT NULL)`; `good_or_better = count(*) FILTER (WHERE cur AND grade IN ('great','good'))`.
- `_NUMBERS_SQL` uses the same predicates.
- `_CALL_COLS` includes `grade`, and `_shape_call` uses `"quality": r["grade"] or "none"`.
- Response shapes are unchanged: `rated_calls, avg_mos, grade, pct_good_or_better`, and per-call `quality`.
- The CSV "Call quality" column comes from the grade word, and `no_rtp` shows as "Poor".

**`docs/CUSTOMER_REPORTING_DESIGN.md` §59-60:** replace the thresholds and the "rated = mos IS NOT NULL" definition with D plus the B.2 rule.

### E.3 Tenant redaction, CSV, Equinox export (API agent)

**`services/tenant_redaction.py`:**
- `TENANT_CDR_SELECT_COLUMNS` += `quality_status, quality_grade, call_quality_status, call_quality_grade, call_mos, burst_ratio, loss_bursts, inbound_media_ratio`.
- `TENANT_CDR_FIELDS` += `quality_by_direction`.
- `FORBIDDEN_TENANT_CDR_KEYS` += `packets_expected` (a 1:1 duration proxy, like `packet_total_count`), `rtp_audio_in_skip_packet_count`, `packets_reordered`, `ssrc_changes`, `fs_mos`, `fs_quality_pct`, `fs_jitter_max_std_ms`, `quality_source`, `call_quality_leg`.
- `_FLOAT_KEYS` += `call_mos, burst_ratio, inbound_media_ratio`.
- Existing keys stay, so no customer field is renamed. `quality_pct` and `jitter_min_ms` now arrive as `null`.

What customers now see: honest `mos` / `r_factor` / loss / jitter, NULL on ungraded calls, plus the grade words.

**`services/cdr_export/exporter.py` `SELECT_COLUMNS` and `formatter.py` `_FIDELITY_BLOCK`:**
- Append a `# --- 50_cdr_quality_accuracy.sql ---` block with the 17 new columns, in B.3 table order, after the migration-48 block.
- Formatters: `_fmt_plain` for varchar/int, `_fmt_num` for numeric.
- The drift test must pass.

**`services/cdr_export/README.md`:** add a "2026-09 semantics change" note for Equinox.
- `mos`, `r_factor`, `packet_loss_pct`, `packet_loss_count`, `jitter_avg_ms` and `jitter_max_ms` changed meaning at deploy time.
- `quality_pct` and `jitter_min_ms` are now empty.
- `quality_source` tells old from new.
- Already-exported rows are NOT re-exported (the `exported_at` watermark is untouched).

### E.4 UI (UI agent) — consumes the B.3 / C.3 contract

**`types/cdr.ts`:**
- Add `quality_status?: 'rated'|'no_rtp'|'low_sample'|'short'|'unanswered'|'no_data'|null`, `quality_grade?: Grade|null`, `call_quality_status?`, `call_quality_grade?`, `call_mos?: number|null`, `burst_ratio?`, `loss_bursts?`, `inbound_media_ratio?`.
- Staff-only optional: `quality_source`, `fs_mos`, `fs_quality_pct`, `fs_jitter_max_std_ms`, `rtp_audio_in_skip_packet_count`, `packets_expected`, `packets_reordered`, `ssrc_changes`, `call_quality_leg`.
- Add `quality_by_direction?: { caller_audio: LegQuality|null; callee_audio: LegQuality|null } | null`.
- Rewrite the field comments (lines 79-104) to the new semantics. `packet_loss_count` = lost packets; the skip counter is `rtp_audio_in_skip_packet_count`.

**`types/reports.ts:14`:** comment → the D thresholds.

**`pages/calls/quality.ts`:**
- Add `export type Grade = 'great'|'good'|'fair'|'poor'`.
- Add `gradeForMos(mos): Grade|null` (4.34 / 4.02 / 3.60), `gradeLabel`, and `gradeTone(grade)` (great/good → GOOD, fair → WARN, poor → BAD, null → INK_FAINT).
- `mosColor` / `mosTone` become `gradeTone(gradeForMos(m))`.
- `rFactorColor` → 80 / 70.
- `packetLossColor` → 4 / 8.
- `jitterColor` stays 20 / 50.
- **Delete `qualityPctColor`.**
- Rewrite the header comment.

**`pages/calls/CdrDetailModal.tsx`:**
- The quality section shows **two columns from `quality_by_direction`**: "Caller's audio (what the callee heard)" and "Callee's audio (what the caller heard)". Each shows grade pill, MOS, R, loss % (+ lost packets), jitter avg/max.
- A status line for non-rated statuses: "Not graded — call under 5 s" / "One-way audio: no inbound media" / "Unanswered" / "Too few packets" / "No media data".
- A header "Call quality: <grade> (worse direction)" from `call_quality_grade`.
- Staff-only diagnostics block: `quality_source`, `fs_mos`, `packets_expected`, `packets_reordered`, `ssrc_changes`, `rtp_audio_in_skip_packet_count` (label "Skipped (autoflush/CNG)"), `fs_jitter_max_std_ms` (label "FS legacy peak jitter std (ms)").
- Remove the MOS 4.0/3.5 and R 80/60 inline thresholds (lines 286-294) and use quality.ts.
- Remove the `quality_pct` tile.

**`pages/calls/CallsKpiStrip.tsx`:**
- Replace the avg MOS / loss / jitter / R tiles with: Graded calls, Good+ % (`call_quality_grade` ∈ great/good ÷ graded), Poor calls (incl. one-way), One-way audio (`call_quality_status='no_rtp'`), Median call MOS (of `call_mos`).
- No averages.

**`pages/calls/QualityTrendsSection.tsx`:** the daily series become:
- Good+ % (call grade)
- median `call_mos`
- p95 `packet_loss_pct` of rated A rows (label "caller→platform loss p95")
- p95 `jitter_avg_ms`
Only rated rows are counted; the sample count comes from graded rows.

**`pages/calls/CallsTable.tsx`:**
- The MOS column shows a pill from `call_quality_grade` with the `call_mos` value; for `no_rtp` show a red "One-way" pill; for ungraded show "—".
- The loss column shows `packet_loss_pct` only when `quality_status==='rated'`.

**`pages/RcfPage.tsx:925` `mosLabel`:** replace with `gradeLabel(call_quality_grade)` → Great / Good / Fair / Poor / One-way / —. Remove the 4.0 / 3.0 thresholds.

**`pages/reporting/ReportCards.tsx:302`:** the thresholds sentence becomes "Great is 4.34 and up, Good 4.02 and up, Fair 3.60 and up; Poor below that, or when one side had no audio. Only answered calls of 5 seconds or more with measurable audio are graded."

**`ReportPdfDocument.tsx:168`:** keep; "measured calls" wording stays.

**`pages/docs/ApiDocsPage.tsx:769-787`:**
- Example becomes `"mos": 4.41, "r_factor": 93.2, "jitter_avg_ms": 1.9, "packet_loss_pct": 0.0, "quality_status": "rated", "quality_grade": "great", "call_quality_grade": "great"`.
- Prose: MOS = ITU-T G.107 E-model from true RTP sequence loss (G.711 max 4.41); NULL unless graded; `jitter_*` = RFC 3550 interarrival jitter; `quality_pct` / `jitter_min_ms` deprecated (always null); plus `quality_by_direction`.

### E.5 Docs

| Doc | Change | Owner |
|---|---|---|
| This file | the contract | — |
| `docs/CDR_LEG_SPLIT_CONTRACT.md` | append "§ quality: B rows feed `call_quality_*` via `cdr_refresh_call_quality`" | API agent |
| `docker/api/CLAUDE.md` | append | API agent |
| `docker/postgres/CLAUDE.md` | append | API agent |
| `infra/monitoring/SLOS.md` | E.1 | Grafana agent |
| `docker/homer/CLAUDE.md` | a line on the new panels, if it lists NOC panels | Grafana agent |
| `docker/ui/CLAUDE.md` | quality.ts is the single UI grade owner | UI agent |
| FS docs | A.7 | FS agent |
| Root `CLAUDE.md` | NOT touched by any agent; the orchestrator adds a one-line gotcha after merge | orchestrator |

---

## F. Alerting — one-way / no-inbound-RTP detector

> **DROPPED by owner, 2026-09-24.** No pager or watchdog: quality is measured accurately and shown on dashboards only. `media_guard.sh`, its systemd units and the installer hook were removed. The text below is kept for history.

The decision is an **on-VM SQL watchdog**, the same pattern as `scripts/backup/asr_guard.sh`. It is the platform's existing PG → page path: `logger -t revup-alert` → Ops Agent → Cloud Logging → `revup_alert_log` policy (infra/monitoring/main.tf:488, 30-min rate limit).

The alternatives were rejected:
- vmalert cannot read PG.
- Grafana has no alerting contact points provisioned (only `provisioning/dashboards|datasources`).
- The ESL exporter cannot see RTP stats without per-channel `uuid_dump`.

Files:
- `scripts/backup/media_guard.sh` (new)
- `scripts/backup/systemd/revup-media-guard.service` + `.timer` (every 10 min, `OnFailure=revup-alert@%p.service`, `User=postgres`)
- `scripts/backup/install_backup_timers.sh`: chmod + `systemctl enable --now revup-media-guard.timer`, header list updated

Logic:
- Tunables in `/etc/revup/backup.env`, with defaults: `MEDIA_GUARD_WINDOW_MIN=30`, `MEDIA_GUARD_MIN_CALLS=3`, `MEDIA_GUARD_MIN_SHARE_PCT=2`.
- Column guard: if `cdrs.call_quality_status` is absent, exit 0 quietly (deploy-order safe, like asr_guard's `HAS_LEG`).
- Query:

```sql
SELECT count(*) FILTER (WHERE call_quality_status = 'no_rtp') AS one_way,
       count(*) FILTER (WHERE call_quality_status IN ('rated','no_rtp')) AS graded,
       string_agg(DISTINCT COALESCE(inbound_carrier,'bandwidth') || '/' || COALESCE(inbound_carrier_pop,'-'), ',')
         FILTER (WHERE call_quality_status = 'no_rtp') AS where_
  FROM cdrs
 WHERE leg IS DISTINCT FROM 'B' AND end_time > now() - make_interval(mins => :window)
```

- Page when `one_way >= MIN_CALLS AND 100*one_way/graded >= MIN_SHARE_PCT`, with this exact line:
  `logger -p user.err -t revup-alert -- "one-way-audio calls=<n>/<graded> window=<w>m carriers=<where_> — check media path (Cloud NAT/bypass-vpn, SDP c=, RTPs source IP) + Homer"`.
- Otherwise exit 0.
- `--dry-run` prints the line instead of calling logger.

The single real one-way call per week seen in production does not page. A NAT/SDP regression (which hits every call) pages within 10 minutes.

Since migration 51, `no_media` calls (no audio in either direction — failed / test calls, both parties silent) are in NEITHER count: a burst of failed test calls can never page as one-way audio.

The visibility half is Grafana noc-home #33 and call-quality #22.

---

## G. Tests and the acceptance lab

### G.1 Local (this Mac: no docker; Python venv, PG16 via `TEST_PG_BIN`, Lua 5.5)

**API/DB agent:**
- **`tests/test_call_quality_model.py` (new):**
  - Table B.1 reference points (exact 2 dp).
  - MOS is monotone non-increasing in loss over a grid 0..100 step 0.01.
  - MOS is monotone in BurstR.
  - Clamps: negative, >100, NaN, None inputs.
  - Codec params.
  - Grade boundaries 4.34 / 4.33, 4.02 / 4.01, 3.60 / 3.59.
  - `no_rtp` → poor with MOS None.
  - Rating-rule table B.2, including the three production cases (0-1 s answered → short; 11 s with 0 received → no_rtp; unanswered with FS mos 4.5 → mos None).
  - BurstR formula and its [1, 10] clamp.
  - Legacy vs patched source selection (`rtp_audio_in_qpatch` absent / present / present-but-seq-missing → legacy).
  - Patched loss = 100*lost/expected. It must not be flaws/packets: a fixture with `flaw_total=30`, `seq_lost=10`, `seq_expected=1000` gives 1.00%.
- **`tests/test_cdr_quality_metrics.py` (update):**
  - Every B.3 column for patched / legacy / garbage inputs.
  - `quality_pct` and `jitter_min_ms` are always None.
  - The skip counter lands in `rtp_audio_in_skip_packet_count`, never in `packet_loss_count`.
  - Remove the `_compute_r_factor` tests.
- **`tests/test_cdr_quality_migration50.py` (new, PG16):**
  - Apply 05 + `cdr_schema` migrations + 50 twice (idempotent).
  - **Python/SQL parity:** 10,000 random (loss, burst, codec) → `round(cq_mos(cq_r_factor()),2)`, `cq_grade`, `cq_leg_status` identical to Python.
  - `cdr_refresh_call_quality`:
    - A-only
    - A+B in both insert orders
    - B `no_rtp` → call no_rtp / poor / call_mos NULL
    - two B attempts (only the answered one used)
    - B arriving before A (0 rows updated, then correct after A)
    - idempotent re-run
  - Backfill script (`psql -f` against the ephemeral cluster, non-TS branch):
    - only `quality_source IS NULL` rows touched
    - second run changes 0 rows
    - snapshot populated
    - `fs_mos` = old `mos`
    - unanswered rows get mos NULL
    - legacy rated row `loss_rate=0.02` → `packet_loss_pct=2.00`, mos 4.23
- **Update:**
  - `tests/cdr_schema.py` — append 50.
  - `test_cdr_schema_guard.py` — REQUIRED columns, tier fallback to 60 when 50 is absent.
  - `test_cdr_leg_split.py` — B ingest triggers the refresh; the pre-50 tier for B rows.
  - `test_tenant_redaction.py` — new allow/forbid sets; `quality_by_direction` nested keys ⊆ allowlist.
  - `test_cdr_export.py` — drift guard.
  - `test_reports.py` — grades from `call_quality_grade`, new thresholds, `no_rtp` → Poor in CSV.
  - `test_support_role_authz.py` / `test_cdr_search_filters.py` — only where they assert column lists.
- **media_guard:** `bash -n` + `shellcheck` (if installed) + a `--dry-run` fixture test against the ephemeral PG (seed 3 `no_rtp` A rows → exactly one line; no column → exit 0 silent).

Run with: `cd /Users/KeGrabhorn/custom-voip/.claude/worktrees/quality && TEST_PG_BIN=<pg16 bin dir> <venv>/bin/python -m pytest tests -q`

**Grafana agent:**
- **`tests/test_grafana_quality_sql.py` (new):**
  - Load the 3 dashboards (valid JSON, unique panel ids, gridPos unchanged for untouched ids).
  - Extract every `rawSql`.
  - Substitute macros: `$__timeFilter(x)` → `x > now() - interval '1 day'`, `$__timeGroup(x,'N')` → `date_bin('N'::interval, x, 'epoch')`, `$zone` → `%`.
  - `EXPLAIN` each against the ephemeral PG16 with migration 50 applied.
  - Assert that no quality panel contains `avg(mos` / `avg(call_mos` / `quality_pct` / `r_factor)`.

**UI agent:**
- `cd docker/ui/app && npx tsc --noEmit && npm run lint && npm run build` (unused imports break the Docker build).
- Add `pages/calls/quality.assert.ts` following the `components/sip-ladder/ladderOrder.assert.ts` pattern, with boundary assertions identical to the Python ones.

**FS agent:**
- `git apply --check` of the patch against a fresh 0a54a48 clone.
- `lua tests/lua/onnet_router_harness.lua && lua tests/lua/trunk_outbound_cdr_harness.lua`, to prove the inbound_router change is comment-only; also `git diff --stat` shows only comment lines.
- `xmllint --noout` on both sofia XMLs.
- Compiling is **not possible locally**. It happens in the lab image build (G.3), with `-Wall -Wextra` on the three patched files; there must be no new warnings versus the unpatched build log.

### G.2 What cannot run locally

- The FreeSWITCH build
- The netem/SIPp lab
- TimescaleDB compressed-chunk behaviour; the backfill's `\if has_ts` branch is exercised in production only. Mitigation: its statements are the same UPDATE body per chunk, and the non-TS branch is tested.

### G.3 Acceptance lab — SIPp + netem (FS agent builds `docker/freeswitch/lab/`; run on `west-loadtest`, which is Linux, isolated, and carries no carrier traffic)

**Contents:**
- `lab/docker-compose.lab.yml`: `fs-lab` = the patched image built from `docker/freeswitch` with a lab conf overlay; `sipp-uac` / `sipp-uas` from `docker/sipp`; a private bridge network.
- `lab/conf/`:
  - A minimal lab profile on 5080 that copies the RTP params from internal.xml (timer, `rtcp-audio-interval-msec`, `suppress-cng=false`, autoflush settings).
  - Dialplan: `9196` answer+echo; `7000` bridge to `sipp-uas`.
  - `json_cdr.conf.xml` = the repo copy with `url` → `http://127.0.0.1:9/`, so every CDR lands on disk.
- `lab/scenarios/uac_stream.xml` / `uas_stream.xml`: SIPp `rtp_stream` of a 60 s PCMU file (`sox -n -r 8000 -e u-law -c 1 tone.ul synth 60 sine 440`) with RFC 2833 digits at t=20 s.
- `lab/run_matrix.sh`: runs each scenario, 20 calls × 60 s, applying netem **in the UAC's netns** (A-in impairment) or the UAS's (B-in).
- `lab/eval_cdrs.py`: imports `docker/api/src/services/call_quality.py` (read-only), parses the on-disk JSON CDRs, asserts the table below and prints a report.

**netem, host-side, single-line:**

```
sudo nsenter -t "$(sudo docker inspect -f '{{.State.Pid}}' lab-sipp-uac)" -n tc qdisc replace dev eth0 root netem loss 3%
```

Clear with `... tc qdisc del dev eth0 root`.

**Acceptance matrix.** It must all pass before any production FS rebuild. "Per-call" means every call; "mean" means over 20 calls.

| # | Impairment (UAC egress unless noted) | Must hold |
|---|---|---|
| 1 | none | loss 0.00, MOS 4.41, grade great, `seq_epochs=1`, `rfc3550_clock=kernel`, jitter_avg < 2 ms |
| 2 | `loss 1%` / `3%` / `5%` / `10%` | mean `packet_loss_pct` within ±0.3 pp of netem; per-call ±1.0 pp; MOS strictly decreasing across the four; legacy `flaw_total/packets` recorded (expect ≈3x) |
| 3 | `loss gemodel 1% 30% 70% 0%` (bursty) | `burst_ratio > 1.5`; `loss_bursts < packet_loss_count`; MOS lower than #2 at equal mean loss |
| 4 | `delay 10ms reorder 5% 50%` | loss ≤ 0.1%; `packets_reordered > 0` |
| 5 | `duplicate 2%` | loss 0.00 |
| 6 | `delay 30ms 5ms distribution normal` | mean `jitter_avg_ms` ∈ [0.75, 1.25] × 5.64 ms (= 2σ/√π, since RFC 3550 J → E\|D\| and D ~ N(0, 2σ²)); loss ≤ 0.2% |
| 7 | UAC sends no RTP (scenario without `rtp_stream`), 15 s | `quality_status='no_rtp'`, grade poor, mos NULL, `packets_expected=0` |
| 8 | 2 s call | `short`, all quality NULL |
| 9 | UAS never answers, CANCEL | `unanswered`, mos NULL (FS legacy `rtp_audio_in_mos` may still be 4.5 → only in `fs_mos`) |
| 10 | RFC 2833 digits mid-call, no impairment | loss 0.00 (DTMF shares seq space) |
| 11 | UAC switches SSRC at t=30 s (second `rtp_stream` segment / re-INVITE) | `ssrc_changes ≥ 1`, loss ≤ 0.1% |
| 12 | impairment on **UAS** egress `loss 3%` | B-leg loss ≈ 3%, A-leg 0, and (through the API in the full-stack variant, or eval_cdrs' combine mirror) call grade = the B grade |
| 13 | every run | all pre-existing `rtp_audio_in_*` variables present with unchanged formats (diff against an unpatched-image run of #1) |

**No-behaviour-change proof:**
- Run #1 and #2 (3%) on the unpatched and patched images.
- The existing FS variables (`rtp_audio_in_mos`, `flaw_total`, `quality_percentage`, variances, counts) are statistically indistinguishable, and call setup/teardown SIP traces are identical.

---

## H. Deploy order and rollback

**Compatibility invariants:**
- The **new API works with OLD FS images**: `qpatch` absent → `quality_source='fs_legacy'`, loss from `loss_rate`, jitter NULL.
- The **old API tolerates migration 50**: nullable columns and functions only; the old API names no new column.
- FS images can be patched before or after the API; the old API ignores the new variables.
- Migration 50 must precede the new API, because read endpoints SELECT the new columns. The INSERT tier fallback exists only as a safety net.

**Order.** All commands are single-line and hostname-guarded. The services VM hostname is `services`.

1. **Merge** to RCF-V1, then on each target `cd /opt/revup && sudo git pull`.
2. **Migration 50 (East primary):**
   `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/50_cdr_quality_accuracy.sql`
   - Verify: `sudo -u postgres psql -d voip -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='cdrs' AND column_name IN ('quality_status','quality_grade','quality_source','call_quality_grade','call_mos')"` → `5`
   - and `sudo -u postgres psql -d voip -Atc "SELECT round(cq_mos(cq_r_factor(0,1))::numeric,2), round(cq_mos(cq_r_factor(1,1))::numeric,2)"` → `4.41|4.33`
3. **API:**
   `hostname | grep -q '^services$' && cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.services.yml up -d --build api`
   - Verify: `curl -s localhost:8000/health/detailed` shows the schema OK. Use the port from `docker-compose.services.yml` if it differs.
   - Verify that `sudo docker logs --since 10m voip-api 2>&1 | grep -c "quality_source"` grows. Use the container name from `docker compose ps`.
4. **Backfill:**
   `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/backfill/50_cdr_quality_backfill.psql`
   - Re-run it once after all API nodes are on the new build. A re-run is a no-op for processed rows.
   - Verify: `sudo -u postgres psql -d voip -Atc "SELECT count(*) FROM cdrs WHERE quality_source IS NULL"` → `0`
5. **Exporter + UI + Grafana:**
   - `hostname | grep -q '^services$' && cd /opt/revup && sudo docker compose -f docker-compose.services.yml up -d --build cdr-exporter ui`
   - Grafana dashboards are bind-mounted (`./docker/homer/grafana/dashboards`). After the pull, run `sudo docker compose -f docker-compose.services.yml restart grafana`.
6. **Watchdog:** `hostname | grep -q '^services$' && sudo /opt/revup/scripts/backup/install_backup_timers.sh && systemctl list-timers revup-media-guard.timer`
7. **FS images, one node at a time, per zone.**
   - Standby first, zero traffic: `east-fs-2`, `west-fs-2`, `central-fs-2`.
   - Then FS-1 in the maintenance window: `fs-media-v2`, `west-fs`, `central-fs`. When FS-1 goes down the SBCs dispatch to the already-patched FS-2 (docs/FS_MEDIA_HA_RUNBOOK.md). Calls in progress on FS-1 drop, which is the accepted maintenance semantic.
   - Per node (replace `NODE`):
     - Tag the rollback image: `hostname | grep -q '^NODE$' && cd /opt/revup && sudo git pull && sudo docker image tag "$(sudo docker compose -f docker-compose.media.yml images -q freeswitch)" revup-fs:pre-qpatch`
     - Build (about 30 min; the patch layer invalidates the compile): `hostname | grep -q '^NODE$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml build freeswitch 2>&1 | tee /tmp/fs-build.log | grep -E "applied /usr/src/fs-patches|error:"`
     - Restart: `hostname | grep -q '^NODE$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml stop freeswitch && sudo killall -9 freeswitch; sudo docker compose -f docker-compose.media.yml up -d freeswitch`
     - Verify the binary: `sudo docker exec voip-freeswitch sh -c 'grep -ac in_seq_expected /usr/local/freeswitch/lib/libfreeswitch.so*'` ≥ 1, and `sudo docker exec voip-freeswitch /usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "sofia status" | grep -c RUNNING` ≥ 2.
     - Verify on a live call (FS-1 only): place the test DID +16174544217 → +17744045256, then `sudo docker exec voip-freeswitch sh -c 'ls -t /var/log/freeswitch/json_cdr/*.json | head -2 | xargs grep -oh "rtp_audio_in_seq_[a-z]*\":\"[0-9]*"'`.
     - In PG, that call's A and B rows must show `quality_source='fs_patch_v1'`, status `rated`, and `call_quality_grade` set.
8. **Post-rollout check (24 h):** `sudo -u postgres psql -d voip -Atc "SELECT quality_source, quality_status, count(*) FROM cdrs WHERE start_time > now()-interval '24 hours' GROUP BY 1,2 ORDER BY 1,2"`. After step 7, `fs_legacy` goes to 0.

**Rollback:**
- **FS:** `hostname | grep -q '^NODE$' && cd /opt/revup && sudo docker compose -f docker-compose.media.yml stop freeswitch && sudo killall -9 freeswitch; sudo docker image tag revup-fs:pre-qpatch "$(sudo docker compose -f docker-compose.media.yml config --images | grep -i freeswitch)" && sudo docker compose -f docker-compose.media.yml up -d --no-build freeswitch`. The API immediately reverts to `fs_legacy` for that node's calls. No data action is needed.
- **API:** check out the previous commit and rebuild `api`. The old API writes `quality_source` NULL; re-run the backfill after roll-forward. Columns and functions stay.
- **Migration 50:** never `DROP COLUMN` on the compressed hypertable. Rollback means "stop writing". The functions are harmless.
- **Backfill (exact):**
  `hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -c "UPDATE cdrs c SET mos=s.mos, quality_pct=s.quality_pct, r_factor=s.r_factor, packet_loss_pct=s.packet_loss_pct, packet_loss_count=s.packet_loss_count, jitter_min_ms=s.jitter_min_ms, jitter_max_ms=s.jitter_max_ms, jitter_avg_ms=s.jitter_avg_ms, quality_source=NULL, quality_status=NULL, quality_grade=NULL, call_quality_status=NULL, call_quality_grade=NULL, call_mos=NULL, call_quality_leg=NULL FROM cdr_quality_backfill_50_snapshot s WHERE c.uuid=s.uuid AND c.start_time=s.start_time AND c.quality_source='backfill_v1'"`
- **Dashboards / UI:** git revert, then restart grafana / rebuild ui.

---

## I. File ownership (no overlap)

| Agent | Owns (create/edit) — nothing else |
|---|---|
| **FS** | `docker/freeswitch/patches/0001-rcf-rtp-quality-v1.patch` (new) · `docker/freeswitch/Dockerfile` · `docker/freeswitch/conf/sofia/internal.xml` (comment) · `docker/freeswitch/conf/sofia/external.xml` (comment) · `docker/freeswitch/scripts/inbound_router.lua` (comment-only) · `docker/freeswitch/CLAUDE.md` · `docker/freeswitch/conf/CLAUDE.md` · `docker/freeswitch/lab/**` (new) |
| **API+DB** | `docker/postgres/init/50_cdr_quality_accuracy.sql` (new) · `docker/postgres/backfill/50_cdr_quality_backfill.psql` (new) · `docker/api/src/services/call_quality.py` (new) · `docker/api/src/routers/cdrs.py` · `docker/api/src/routers/reports.py` · `docker/api/src/services/reporting.py` · `docker/api/src/services/tenant_redaction.py` · `docker/api/src/services/cdr_export/{exporter.py,formatter.py,README.md}` · `docker/api/src/db/schema_check.py` · `scripts/backup/media_guard.sh` (new) · `scripts/backup/systemd/revup-media-guard.{service,timer}` (new) · `scripts/backup/install_backup_timers.sh` · `tests/cdr_schema.py` · `tests/test_call_quality_model.py` (new) · `tests/test_cdr_quality_migration50.py` (new) · `tests/test_cdr_quality_metrics.py` · `tests/test_cdr_schema_guard.py` · `tests/test_cdr_leg_split.py` · `tests/test_tenant_redaction.py` · `tests/test_cdr_export.py` · `tests/test_reports.py` · `tests/test_support_role_authz.py` · `tests/test_cdr_search_filters.py` · `docs/CUSTOMER_REPORTING_DESIGN.md` · `docs/CDR_LEG_SPLIT_CONTRACT.md` · `docker/api/CLAUDE.md` · `docker/postgres/CLAUDE.md` |
| **Grafana** | `docker/homer/grafana/dashboards/noc/call-quality.json` · `docker/homer/grafana/dashboards/noc/noc-home.json` · (`traffic-status.json`: verify only, no edit) · `infra/monitoring/SLOS.md` · `docker/homer/CLAUDE.md` · `tests/test_grafana_quality_sql.py` (new) |
| **UI** | `docker/ui/app/src/types/cdr.ts` · `docker/ui/app/src/types/reports.ts` · `docker/ui/app/src/pages/calls/{quality.ts,quality.assert.ts (new),CdrDetailModal.tsx,CallsKpiStrip.tsx,QualityTrendsSection.tsx,CallsTable.tsx}` · `docker/ui/app/src/pages/RcfPage.tsx` · `docker/ui/app/src/pages/reporting/{ReportCards.tsx,ReportPdfDocument.tsx}` · `docker/ui/app/src/pages/docs/ApiDocsPage.tsx` · `docker/ui/CLAUDE.md` |

**Cross-agent reads (read-only, never edited by the reader):**
- The FS lab `eval_cdrs.py` imports `services/call_quality.py`.
- Grafana SQL tests apply `50_cdr_quality_accuracy.sql`.
- The UI mirrors D and C.3.

If one agent needs a change in another's file, it asks the orchestrator. It does not edit.

**Parallel start:**
- All four can start at once, because this document fixes every interface: variable names (A.5), columns and types (B.3), functions (B.4), JSON shape (C.3) and grades (D).
- The API agent should land `services/call_quality.py` and migration 50 first, since the lab and the Grafana tests depend on them.
