#!/usr/bin/env bash
# Call-quality acceptance lab driver (docs/CALL_QUALITY_ACCURACY_PLAN.md G.3).
# Run on west-loadtest ONLY, as root:   sudo ./run_matrix.sh <command>
#
# Commands:
#   stage              copy the repo switch.conf.xml + json_cdr.conf.xml (url -> http://127.0.0.1:9/) into conf/
#   build              build the PATCHED lab-fs image (revup-fs-lab:patched) + the sipp image
#   build-unpatched    build revup-fs-lab:unpatched from the commit BEFORE the patch (UNPATCHED_REF overrides)
#   warncheck          -Wall -Wextra compile of switch_rtp.c / switch_core_media.c in both builder images; diff warnings
#   up | down          start / stop the lab containers (FS_LAB_IMAGE selects the FS image)
#   run [S..]          run scenarios (default: all of MATRIX below) into out/<RUNSET>/<scenario>/
#   all                stage + build + up + run all + eval   (patched image)
#   compare            unpatched vs patched no-behaviour-change proof (S01 + S02_loss3 on both) + eval --compare
#   netem-show         print the qdisc/filter state of both sipp netns
#
# Environment knobs: LAB_CALLS (20), LAB_DUR_S (60), LAB_RATE_MS (2000 = 1 call / 2 s),
#   LAB_NET_PREFIX (172.31.77), RUNSET (runs-patched), NETEM_SCOPE (rtp | iface).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
REPO_FS=$(cd "$HERE/.." && pwd)                     # docker/freeswitch
REPO_ROOT=$(cd "$HERE/../../.." && pwd)
COMPOSE=(docker compose -f "$HERE/docker-compose.lab.yml")
P=${LAB_NET_PREFIX:-172.31.77}
FS_IP=$P.10 UAC_IP=$P.20 UAS_IP=$P.30
CALLS=${LAB_CALLS:-20}
DUR_S=${LAB_DUR_S:-60}
RATE_MS=${LAB_RATE_MS:-2000}
RUNSET=${RUNSET:-runs-patched}
GIT=(git -c 'safe.directory=*' -C "$REPO_ROOT")   # root on a user-owned checkout
NETEM_SCOPE=${NETEM_SCOPE:-rtp}
OUT=$HERE/out

# name | uac scenario | uas scenario | dialed | uac mode | uas mode | call seconds | netem target | netem args
MATRIX=(
	"S01_clean|uac_stream|uas_stream|7000|wrap|normal|$DUR_S|-|"
	"S02_loss1|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uac|loss 1%"
	"S02_loss3|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uac|loss 3%"
	"S02_loss5|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uac|loss 5%"
	"S02_loss10|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uac|loss 10%"
	"S03_gemodel|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uac|loss gemodel 1% 30% 70% 0%"
	"S04_reorder|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uac|delay 10ms reorder 5% 50%"
	"S05_dup|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uac|duplicate 2%"
	"S06_jitter|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uac|delay 30ms 5ms distribution normal"
	"S07_norpt|uac_stream|uas_stream|7000|none|normal|15|-|"
	"S08_short|uac_stream|uas_stream|7000|normal|normal|2|-|"
	"S09_cancel|uac_cancel|uas_noanswer|7000|-|-|0|-|"
	"S10_dtmf|uac_stream|uas_stream|7000|dtmf|normal|$DUR_S|-|"
	"S11_ssrc|uac_stream|uas_stream|7000|ssrc|normal|$DUR_S|-|"
	"S12_bloss|uac_stream|uas_stream|7000|normal|normal|$DUR_S|uas|loss 3%"
)

log() { printf '%s [lab] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo): netem via nsenter + root-owned container output"; }

stage() {
	local src=$REPO_FS/conf/autoload_configs
	cp "$src/switch.conf.xml" conf/autoload_configs/switch.conf.xml
	sed 's#<param name="url" value="[^"]*"/>#<param name="url" value="http://127.0.0.1:9/"/>#' "$src/json_cdr.conf.xml" > conf/autoload_configs/json_cdr.conf.xml
	grep -q 'value="http://127.0.0.1:9/"' conf/autoload_configs/json_cdr.conf.xml || die "json_cdr url rewrite failed"
	grep -q 'name="log-http-and-disk" value="true"' conf/autoload_configs/json_cdr.conf.xml || die "repo json_cdr no longer writes to disk (log-http-and-disk) - lab needs it"
	grep -q 'name="log-b-leg" value="true"' conf/autoload_configs/json_cdr.conf.xml || die "repo json_cdr has log-b-leg off - B-in checks need it"
	mkdir -p "$OUT/fs-log/json_cdr" "$OUT/senders" "$OUT/sender-logs"
	log "staged switch.conf.xml + json_cdr.conf.xml (url -> http://127.0.0.1:9/)"
}

build() {
	"${COMPOSE[@]}" build lab-sipp-uac
	docker build -t revup-fs-lab:patched "$REPO_FS" 2>&1 | tee "$OUT/build-patched.log"
	grep -q 'applied /usr/src/fs-patches/0001-rcf-rtp-quality-v1.patch' "$OUT/build-patched.log" || die "patch was not applied in the patched build (see out/build-patched.log)"
	log "patched image built; patch applied"
}

unpatched_ctx() {
	local ref=${UNPATCHED_REF:-}
	if [ -z "$ref" ]; then
		local c
		c=$("${GIT[@]}" log -1 --format=%H --diff-filter=A -- docker/freeswitch/patches/0001-rcf-rtp-quality-v1.patch || true)
		[ -n "$c" ] || die "patch not committed yet: set UNPATCHED_REF=<commit without docker/freeswitch/patches> (e.g. origin/RCF-V1 before the merge)"
		ref="$c^"
	fi
	local wt=/tmp/rcf-fs-unpatched
	rm -rf "$wt"; "${GIT[@]}" worktree prune
	"${GIT[@]}" worktree add --detach "$wt" "$ref" >/dev/null
	[ ! -d "$wt/docker/freeswitch/patches" ] || die "UNPATCHED_REF $ref already contains docker/freeswitch/patches"
	echo "$wt/docker/freeswitch"
}

build_unpatched() {
	local ctx; ctx=$(unpatched_ctx)
	docker build -t revup-fs-lab:unpatched "$ctx" 2>&1 | tee "$OUT/build-unpatched.log"
	log "unpatched image built from $ctx"
}

warncheck() {
	local ctx_un; ctx_un=$(unpatched_ctx)
	docker build --target builder -t revup-fs-lab:builder-patched "$REPO_FS" >/dev/null
	docker build --target builder -t revup-fs-lab:builder-unpatched "$ctx_un" >/dev/null
	local v
	for v in patched unpatched; do
		docker run --rm "revup-fs-lab:builder-$v" sh -c 'cd /usr/src/freeswitch && for o in src/libfreeswitch_la-switch_rtp.lo src/libfreeswitch_la-switch_core_media.lo; do rm -f "$o"; make "$o" CFLAGS="-g -O2 -Wall -Wextra -Wno-error" 2>&1; done' > "$OUT/warn-$v.log" 2>&1 || true
		grep -E 'warning:|error:' "$OUT/warn-$v.log" | sed -E 's/:[0-9]+:[0-9]+:/:L:C:/' | sort > "$OUT/warn-$v.norm" || true
	done
	log "warnings: unpatched $(wc -l < "$OUT/warn-unpatched.norm"), patched $(wc -l < "$OUT/warn-patched.norm")"
	if diff "$OUT/warn-unpatched.norm" "$OUT/warn-patched.norm" > "$OUT/warn-diff.txt"; then
		log "PASS warncheck: no new warnings in the patched translation units"
	else
		cat "$OUT/warn-diff.txt"; die "warncheck: patched build has new/different warnings (out/warn-diff.txt)"
	fi
	if grep -q 'error:' "$OUT/warn-patched.log"; then die "warncheck: patched TU has errors"; fi
}

up() {
	stage
	"${COMPOSE[@]}" up -d --no-build
	local i
	for i in $(seq 1 60); do
		if docker exec lab-fs /usr/local/freeswitch/bin/fs_cli -p "${LAB_ESL_PASSWORD:-lab-only-not-a-secret}" -x 'sofia status' 2>/dev/null | grep -c RUNNING | grep -q '^[2-9]'; then
			log "lab-fs up: $(docker exec lab-fs /usr/local/freeswitch/bin/fs_cli -p "${LAB_ESL_PASSWORD:-lab-only-not-a-secret}" -x version)"
			return 0
		fi
		sleep 2
	done
	docker logs --tail 50 lab-fs; die "lab-fs did not come up (2 sofia profiles RUNNING)"
}

down() { "${COMPOSE[@]}" down; }

# netem in a sipp container's netns, from the host. NETEM_SCOPE=rtp (default) impairs ONLY the lab
# RTP sender's packets (UDP sport 32768-49151), so SIP is never impaired; NETEM_SCOPE=iface is the
# plan's whole-interface form:  nsenter -t PID -n tc qdisc replace dev eth0 root netem <args>
netem_clear() {
	local pid; pid=$(docker inspect -f '{{.State.Pid}}' "$1")
	nsenter -t "$pid" -n tc qdisc del dev eth0 root 2>/dev/null || true
}
netem_apply() {
	local ctr=$1; shift
	local pid; pid=$(docker inspect -f '{{.State.Pid}}' "$ctr")
	netem_clear "$ctr"
	if [ "$NETEM_SCOPE" = iface ]; then
		# shellcheck disable=SC2068
		nsenter -t "$pid" -n tc qdisc replace dev eth0 root netem $@
	else
		nsenter -t "$pid" -n tc qdisc add dev eth0 root handle 1: prio bands 4 priomap 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
		# shellcheck disable=SC2068
		nsenter -t "$pid" -n tc qdisc add dev eth0 parent 1:4 handle 40: netem $@
		nsenter -t "$pid" -n tc filter add dev eth0 protocol ip parent 1:0 prio 1 u32 match ip protocol 17 0xff match ip sport 32768 0xc000 flowid 1:4
	fi
	log "netem on $ctr ($NETEM_SCOPE): $*"
}
netem_show() {
	local c pid
	for c in lab-sipp-uac lab-sipp-uas; do
		pid=$(docker inspect -f '{{.State.Pid}}' "$c")
		echo "== $c"; nsenter -t "$pid" -n tc -s qdisc show dev eth0; nsenter -t "$pid" -n tc filter show dev eth0 || true
	done
}

sipp_running() { docker top "$1" 2>/dev/null | grep -q '[s]ipp '; }

run_one() {
	local spec=$1
	local name uacsf uassf svc uacmode uasmode secs target nargs
	IFS='|' read -r name uacsf uassf svc uacmode uasmode secs target nargs <<< "$spec"
	local dir=$OUT/$RUNSET/$name
	rm -rf "$dir"; mkdir -p "$dir/cdr" "$dir/senders" "$dir/sipp"
	rm -f "$OUT"/fs-log/json_cdr/*.json "$OUT"/senders/*.json
	netem_clear lab-sipp-uac; netem_clear lab-sipp-uas
	# shellcheck disable=SC2086
	if [ "$target" = uac ]; then netem_apply lab-sipp-uac $nargs; fi
	# shellcheck disable=SC2086
	if [ "$target" = uas ]; then netem_apply lab-sipp-uas $nargs; fi
	local pause_ms=$(( secs * 1000 ))
	local uac_rtp uas_rtp
	uac_rtp=$(awk -v s="$secs" 'BEGIN{v=s-0.5; if (v<0.5) v=0.5; printf "%.1f", v}')
	uas_rtp=$(awk -v s="$secs" 'BEGIN{v=s-1.0; if (v<0.5) v=0.5; printf "%.1f", v}')
	local budget=$(( CALLS * RATE_MS / 1000 + secs + 60 ))
	local common=(-nostdin -trace_msg -trace_err -trace_logs -timeout "${budget}s" -timeout_error)
	log "run $name: $CALLS calls x ${secs}s  uac=$uacsf/$uacmode uas=$uassf/$uasmode netem=${target}:${nargs:-none}"
	docker exec -d lab-sipp-uas sipp -sf "/lab/scenarios/$uassf.xml" -i "$UAS_IP" -p 5060 -mp 6000 -m "$CALLS" -key rtpdur "$uas_rtp" -key mode "$uasmode" \
		"${common[@]}" -message_file "/lab/out/$RUNSET/$name/sipp/uas_messages.log" -error_file "/lab/out/$RUNSET/$name/sipp/uas_errors.log" -log_file "/lab/out/$RUNSET/$name/sipp/uas_logs.log"
	sleep 1
	local rc=0
	docker exec lab-sipp-uac sipp "$FS_IP:5080" -sf "/lab/scenarios/$uacsf.xml" -s "$svc" -i "$UAC_IP" -p 5060 -mp 6000 -m "$CALLS" -l 25 -r 1 -rp "$RATE_MS" -d "$pause_ms" \
		-key rtpdur "$uac_rtp" -key mode "$uacmode" "${common[@]}" \
		-message_file "/lab/out/$RUNSET/$name/sipp/uac_messages.log" -error_file "/lab/out/$RUNSET/$name/sipp/uac_errors.log" -log_file "/lab/out/$RUNSET/$name/sipp/uac_logs.log" \
		> "$dir/sipp/uac_stdout.txt" 2>&1 || rc=$?
	echo "$rc" > "$dir/sipp/uac_exit_code"
	local i
	for i in $(seq 1 30); do sipp_running lab-sipp-uas || break; sleep 1; done
	if sipp_running lab-sipp-uas; then log "WARN $name: UAS sipp still running - restarting lab-sipp-uas"; docker restart lab-sipp-uas >/dev/null; fi
	netem_clear lab-sipp-uac; netem_clear lab-sipp-uas
	sleep 8   # json_cdr: POST to :9 fails (retries x delay) then the on-disk copy is complete
	mv "$OUT"/fs-log/json_cdr/*.json "$dir/cdr/" 2>/dev/null || true
	mv "$OUT"/senders/*.json "$dir/senders/" 2>/dev/null || true
	printf '%s\n' "$spec" > "$dir/spec.txt"
	log "done $name: sipp uac exit=$rc, $(find "$dir/cdr" -name '*.json' | wc -l) CDR files, $(find "$dir/senders" -name '*.json' | wc -l) sender manifests"
}

run() {
	need_root
	local want=("$@") spec name
	for spec in "${MATRIX[@]}"; do
		name=${spec%%|*}
		if [ ${#want[@]} -gt 0 ]; then
			local hit=0 w
			for w in "${want[@]}"; do [ "$w" = "$name" ] && hit=1; done
			[ $hit -eq 1 ] || continue
		fi
		run_one "$spec"
	done
}

evaluate() {
	python3 "$HERE/eval_cdrs.py" --runs "$OUT/$RUNSET" --report "$OUT/$RUNSET/REPORT.txt" "$@"
}

cmd=${1:-help}; shift || true
case "$cmd" in
	stage) stage ;;
	build) mkdir -p "$OUT"; build ;;
	build-unpatched) mkdir -p "$OUT"; build_unpatched ;;
	warncheck) need_root; mkdir -p "$OUT"; warncheck ;;
	up) up ;;
	down) down ;;
	run) run "$@" ;;
	eval) evaluate "$@" ;;
	netem-show) need_root; netem_show ;;
	all) need_root; mkdir -p "$OUT"; stage; build; FS_LAB_IMAGE=revup-fs-lab:patched up; RUNSET=runs-patched run; RUNSET=runs-patched evaluate ;;
	compare)
		need_root; mkdir -p "$OUT"
		docker image inspect revup-fs-lab:unpatched >/dev/null 2>&1 || build_unpatched
		down || true; FS_LAB_IMAGE=revup-fs-lab:unpatched up; RUNSET=runs-unpatched run S01_clean S02_loss3
		down; FS_LAB_IMAGE=revup-fs-lab:patched up
		[ -d "$OUT/runs-patched/S01_clean" ] || RUNSET=runs-patched run S01_clean S02_loss3
		python3 "$HERE/eval_cdrs.py" --runs "$OUT/runs-patched" --compare "$OUT/runs-unpatched" --report "$OUT/COMPARE.txt" --only S01_clean,S02_loss3
		;;
	*) sed -n '2,22p' "$0"; exit 2 ;;
esac
