# Call-quality acceptance lab (quality patch v1)

Contract: `docs/CALL_QUALITY_ACCURACY_PLAN.md` section G.3 (this lab), section A (the FreeSWITCH
patch `docker/freeswitch/patches/0001-rcf-rtp-quality-v1.patch`), section B (the model in
`docker/api/src/services/call_quality.py`, which `eval_cdrs.py` imports read-only).

**Every check below must pass before ANY production FreeSWITCH image is rebuilt with the patch.**

Run it on **`west-loadtest` only** (Linux, isolated, no carrier traffic). Never on a production
media or SBC VM. The lab is a private Docker bridge network. It publishes no host ports and does
not touch the host's own interfaces: netem goes into the SIPp containers' network namespaces.

## What it is

```
 lab-sipp-uac (172.31.77.20)        lab-fs (172.31.77.10)              lab-sipp-uas (172.31.77.30)
 SIPp UAC + rtp_send.py  --RTP-->  lab-int:5080  A-leg   bridge 7000   lab-ext:5090  B-leg  <--RTP--  SIPp UAS + rtp_send.py
   netem here = A-in impairment      (patched or unpatched image)        netem here = B-in impairment
                                     json_cdr -> out/fs-log/json_cdr/*.json (A and B CDRs)
```

- `lab-fs` is the **real image** built from `docker/freeswitch` (the same Dockerfile as
  production). The lab config (`conf/`) copies the RTP params of `conf/sofia/internal.xml` /
  `external.xml`. It uses the **repo** `switch.conf.xml` (autoflush-during-bridge, timer, port
  range) and the **repo** `json_cdr.conf.xml` with only `url` rewritten to `http://127.0.0.1:9/`.
  `run_matrix.sh stage` copies both into `conf/autoload_configs/`, so every CDR lands on disk.
- SIPp (image from `docker/sipp`) does all SIP signalling. The RTP comes from
  `scripts/rtp_send.py`, which the SIPp scenario starts once the call is answered. It sends PCMU at
  20 ms with absolute-deadline pacing. It is used instead of SIPp's `rtp_stream` because checks #10
  and #11 need RFC 2833 events **in the same seq/SSRC space** and a **mid-call SSRC switch**, and
  every call needs a ground-truth manifest of what was sent. SIPp's `rtp_stream` provides none of
  these.
- netem goes on the sender's container egress. The default is `NETEM_SCOPE=rtp`: a `prio` qdisc
  plus a u32 filter impair **only** UDP from source ports 32768-49151, which is the RTP sender's
  range, so SIP is never impaired. `NETEM_SCOPE=iface` applies the plan's whole-interface form:
  `sudo nsenter -t "$(sudo docker inspect -f '{{.State.Pid}}' lab-sipp-uac)" -n tc qdisc replace dev eth0 root netem loss 3%`
  (clear it with `... tc qdisc del dev eth0 root`).
- `eval_cdrs.py` parses the on-disk CDRs and scores each leg with `call_quality.assess_leg()`.
  It combines the two legs with `combine_call()`, which mirrors the SQL `cdr_refresh_call_quality()`,
  and cross-checks against the sender manifests. It then asserts the matrix below.

## Prerequisites on west-loadtest

Docker with the compose plugin, `python3` (3.9+), `iproute2` (`tc`), `util-linux` (`nsenter`),
`git`, and a checkout of this repo. The commands assume `/opt/revup`. About 10 GB of disk is
needed for two FS images. Each FS image build takes about 30-40 min on an e2-standard-4.

## Exact command sequence

All commands are single-line and run from the lab directory. `sudo` is required, because netem
runs via nsenter and the container output is root-owned.

1. Get the branch:
   `cd /opt/revup && sudo git fetch origin && sudo git checkout feat/call-quality-accuracy && sudo git pull`
2. Offline gates (seconds). They compile the tracker straight out of the patch file and self-test the evaluator:
   `cd /opt/revup/docker/freeswitch/lab && sh unit/run_unit.sh && python3 unit/eval_selftest.py`
3. Full matrix on the PATCHED image (stage + build + up + all 15 runs + eval; about 35 min of runs after the build):
   `cd /opt/revup/docker/freeswitch/lab && sudo ./run_matrix.sh all 2>&1 | tee /tmp/qlab-all.log`
   The result is in `out/runs-patched/REPORT.txt`. Its last line must read `RESULT: ... 0 FAIL ... -> ACCEPT`.
4. No-behaviour-change proof: build the UNPATCHED image and run #1 and #2 (3%) on both images.
   Set `UNPATCHED_REF` to the branch base (the commit before the patch). Once the patch is merged,
   omit it and the script finds the commit that added the patch, then takes its parent:
   `cd /opt/revup/docker/freeswitch/lab && sudo UNPATCHED_REF="$(sudo git -C /opt/revup merge-base HEAD origin/RCF-V1)" ./run_matrix.sh compare 2>&1 | tee /tmp/qlab-compare.log`
   The result is in `out/COMPARE.txt`.
5. Compiler-warning gate: `-Wall -Wextra` on the patched `switch_rtp.c` / `switch_core_media.c`,
   compared with the unpatched build. It needs zero new warnings:
   `cd /opt/revup/docker/freeswitch/lab && sudo UNPATCHED_REF="$(sudo git -C /opt/revup merge-base HEAD origin/RCF-V1)" ./run_matrix.sh warncheck`
6. Tear down: `cd /opt/revup/docker/freeswitch/lab && sudo ./run_matrix.sh down`

Useful extras:

- Re-run one scenario: `sudo ./run_matrix.sh run S06_jitter && sudo ./run_matrix.sh eval --only S06_jitter`
- Quick smoke test with 2 calls of 20 s: `sudo LAB_CALLS=2 LAB_DUR_S=20 RUNSET=runs-smoke ./run_matrix.sh run S01_clean && sudo RUNSET=runs-smoke ./run_matrix.sh eval`
- Show the live qdisc state: `sudo ./run_matrix.sh netem-show`
- Talk to the lab FS: `sudo docker exec lab-fs /usr/local/freeswitch/bin/fs_cli -p lab-only-not-a-secret -x 'show channels'`

Output layout: `out/<runset>/<scenario>/{cdr/*.json, senders/*.json, sipp/*, spec.txt}`, plus
`out/build-*.log` and `out/warn-*`.

## The acceptance matrix (13 checks)

These are 20 calls × 60 s unless noted, 1 call every 2 s. "Per call" means every call; "mean"
means the mean over the 20 calls. Impairment is on UAC egress (caller→platform, measured on the
A-leg) unless noted.

| # | Scenario (run name) | Impairment | Must hold (eval check ids) |
|---|---|---|---|
| 1 | `S01_clean` | none (UAC seq starts at 65200, so the 65535→0 wrap happens live) | per call: `packet_loss_pct` 0.00, MOS 4.41, grade `great`, `seq_epochs`=1, `rfc3550_clock`=`kernel`, `jitter_avg_ms` < 2 (`#1`). B-in the same (`#1b`). `seq_expected` == packets sent per the sender manifest (`#1c`) |
| 2 | `S02_loss1/3/5/10` | `loss 1%` / `3%` / `5%` / `10%` | mean `packet_loss_pct` within ±0.3 pp of netem (`#2`). Per call within max(1.0 pp, 4σ binomial) (`#2p`, see deviations). MOS strictly decreasing across the four (`#2m`). Legacy `flaw_total/packets` is printed next to true loss (expect ≈3x, informational) |
| 3 | `S03_gemodel` | `loss gemodel 1% 30% 70% 0%` (bursty) | mean `burst_ratio` > 1.5 (`#3a`). `loss_bursts` < `packet_loss_count` on every lossy call (`#3b`). Quality lower than random loss at the same loss: R strictly lower and MOS not higher, per call (`#3c`). The empirical comparison with the #2 curve is printed |
| 4 | `S04_reorder` | `delay 10ms reorder 5% 50%` | per call loss ≤ 0.1% (`#4a`). `packets_reordered` > 0 (`#4b`) |
| 5 | `S05_dup` | `duplicate 2%` | per call loss 0.00 (`#5`) |
| 6 | `S06_jitter` | `delay 30ms 5ms distribution normal` | mean `jitter_avg_ms` ∈ [0.75, 1.25] × 5.64 ms (`#6a`; 5.64 = 2σ/√π, because RFC 3550 J → E\|D\| and D ~ N(0, 2σ²)). Per call loss ≤ 0.2% (`#6b`) |
| 7 | `S07_norpt` | the UAC sends **no** RTP, 15 s calls | A: `quality_status`=`no_rtp`, grade `poor`, MOS NULL, `packets_expected`=0. Call status `no_rtp` (`#7`) |
| 8 | `S08_short` | 2 s calls | every leg `short`, all quality NULL (`#8`) |
| 9 | `S09_cancel` | the UAS never answers, the UAC CANCELs after 5 s | every leg `unanswered`, MOS NULL (`#9`). FS's legacy `rtp_audio_in_mos` may still be 4.50; it is shown only as `fs_mos` |
| 10 | `S10_dtmf` | none; RFC 2833 digits "1234" at t=20 s in the same seq/SSRC space | per call loss 0.00, `seq_epochs`=1, `rtp_audio_in_dtmf_packet_count` > 0 (`#10`). `seq_expected` == sent (`#10b`) |
| 11 | `S11_ssrc` | none; new SSRC + seq + ts at t=30 s | `ssrc_changes` ≥ 1, loss ≤ 0.1% (`#11`). `seq_expected` == sent over both epochs (`#11b`) |
| 12 | `S12_bloss` | `loss 3%` on **UAS** egress (callee→platform) | B-leg mean loss within ±0.3 pp of 3% (`#12a`). A-leg loss 0.00 (`#12b`). Call grade from `combine_call`, the worse direction, == the B grade (`#12c`) |
| 13 | every run | — | every pre-existing `rtp_audio_*` variable is present with its unchanged format, and the A.5 variables are present and typed on every media leg (`#13`). **`compare`**: patched rtp_* names = unpatched + exactly the A.5 set (`#13d`); value formats identical (`#13f`); legacy FS stats (`mos`, `flaw_total`, `quality_percentage`, variances, loss/burst rate, counts) statistically indistinguishable, \|Welch t\| ≤ 3 (`#13s`); SIP setup/teardown ladders identical (`#13l`) |

**Pass criteria for promotion to production:** `REPORT.txt` shows 0 FAIL, `COMPARE.txt`
shows 0 FAIL, and `warncheck` prints `PASS warncheck`. A SKIP is acceptable only for
`#13` on `S09_cancel`, which has no media legs.

### Deviations from the plan's literal wording (and why)

- **RTP source.** The plan specifies SIPp `rtp_stream` with a sox-generated file. This lab uses
  `scripts/rtp_send.py` instead. SIPp still does all SIP. The reason is in "What it is" above.
- **#2 per-call tolerance.** The plan's flat ±1.0 pp per call cannot hold statistically at 10%.
  For about 3,000 packets, one binomial σ is 0.55 pp, so ±1.0 pp is only 1.8σ, and some call out
  of 20 would fall outside it about 75% of the time. `#2p` uses max(1.0 pp, 4σ) and also prints
  how many calls the flat bound would flag. The mean criterion (±0.3 pp) is kept as written.
- **#3 "MOS lower at equal loss"** is asserted on R and per call (see `#3c`). At the GE model's
  ≈2.2% mean loss, a BurstR of ≈1.8 costs only ≈0.25 R (≈0.006 MOS) with Bpl=25.1. The 2-dp MOS
  can therefore tie, and a means-vs-means comparison of two 20-call samples would be a coin flip.
- **netem scope.** The default applies netem to RTP only, so SIP retransmission timing cannot
  perturb the runs. The plan's whole-interface command is still available as `NETEM_SCOPE=iface`.

## Troubleshooting

- **`rfc3550_clock=read` in #1.** `ioctl(SIOCGSTAMP)` failed on the RTP socket, so arrivals fell
  back to FS read time, which is quantized to the 20 ms timer, and J is inflated. Check that
  lab-fs is the patched image (`grep -ac in_seq_expected` on `libfreeswitch.so`) and that the
  kernel is Linux ≥ 2.6. This fails #1 by design.
- **#6 reads far below 5.64 ms with `clock=kernel`.** That would mean the receive timestamp
  pre-dates netem's delay. Normally the kernel clears `skb->tstamp` when netem dequeues and when
  the packet crosses the veth/netns boundary, and re-stamps it on receive. Retry with
  `NETEM_SCOPE=iface`, and report the kernel version (`uname -r`). This is a lab-topology
  artefact: in production the NIC receive path stamps packets directly.
- **`uac exit=1`** in the run log means some SIPp calls failed. See
  `out/<runset>/<scenario>/sipp/uac_errors.log` and `uac_stdout.txt`. The SIPp flags used
  (`-nostdin`, `-timeout_error`, `-message_file`, `-log_file`) exist in the Debian bookworm
  `sip-tester` (3.6.x).
- **Sender pacing.** `REPORT.txt` prints the mean lateness of the UAC sender. The RFC 3550 J
  measured at FS can never be below the sender's own send-time jitter. Values up to a few
  hundred µs are fine against the #1 bound of 2 ms. If it is higher, the box is CPU-starved:
  lower the rate with `LAB_RATE_MS=4000` or raise the spin window with `RTP_SEND_SPIN_MS=2`.

## What only this lab can prove (and what it cannot)

- The lab proves that the real patched binary produces the A.5 variables with correct values
  under real kernel, netem, veth and FS timer/autoflush behaviour, and that it changes nothing
  observable in the legacy variables or the SIP flow.
- The unit test (`unit/run_unit.sh`) proves the tracker arithmetic on this exact patch text,
  including wrap, reorder, duplicates, SSRC/epoch handling, the jitter recurrence and the
  clock-switch guard. It uses mocked sockets, so it cannot prove the SIOCGSTAMP semantics of a
  real kernel. The lab covers that (#1, #6).
- Neither proves production carrier behaviour. That is plan H step 7: patch the standby FS
  first, then place a live test call on FS-1 and check the `quality_source='fs_patch_v1'` rows.
