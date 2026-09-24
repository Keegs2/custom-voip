#!/bin/sh
# Launched by the SIPp scenarios (<exec command=...>) once the call is up.
# Backgrounds rtp_send.py so SIPp's scenario continues immediately.
#   start_rtp.sh <uac|uas> <call_id> <fs_rtp_ip> <fs_rtp_port> <seconds> <mode>
# modes: normal  steady PCMU, random start seq
#        wrap    steady PCMU, start seq 65200 (crosses 65535->0 at ~6.7 s)
#        dtmf    RFC 2833 digits "1234" at t=20 s, same seq/SSRC space
#        ssrc    new SSRC + seq + ts at t=30 s (a re-originated stream)
#        none    send NO RTP (one-way audio case)
set -u
ROLE=$1 CALLID=$2 IP=$3 PORT=$4 DUR=$5 MODE=${6:-normal}
OUT=${LAB_OUT:-/lab/out}
case "$MODE" in
	normal) EXTRA="" ;;
	wrap)   EXTRA="--seq-start 65200" ;;
	dtmf)   EXTRA="--dtmf-at 20" ;;
	ssrc)   EXTRA="--ssrc-switch-at 30" ;;
	none)   EXTRA="--no-rtp" ;;
	*) echo "start_rtp.sh: unknown mode $MODE" >&2; exit 2 ;;
esac
mkdir -p "$OUT/senders" "$OUT/sender-logs"
# shellcheck disable=SC2086
nohup python3 /lab/scripts/rtp_send.py --role "$ROLE" --call-id "$CALLID" --host "$IP" --port "$PORT" --duration "$DUR" --manifest-dir "$OUT/senders" $EXTRA >"$OUT/sender-logs/${ROLE}_${CALLID}.log" 2>&1 &
exit 0
