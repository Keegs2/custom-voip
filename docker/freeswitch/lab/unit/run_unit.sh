#!/bin/sh
# Unit test of the RCF quality patch v1 tracker, compiled from the EXACT patch bytes.
# Runs on macOS (clang) or Linux (cc/gcc). No FreeSWITCH tree needed.
#   sh docker/freeswitch/lab/unit/run_unit.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PATCH="$HERE/../../patches/0001-rcf-rtp-quality-v1.patch"
OUT=${TMPDIR:-/tmp}/qt_unit.$$
mkdir -p "$OUT"
trap 'rm -rf "$OUT"' EXIT
CC=${CC:-cc}

# Extract a file's added lines ('+' prefix stripped) from the patch.
added_lines() { # $1 = path inside the patch (e.g. src/switch_rtp.c)
	awk -v f="$1" '
		/^diff --git / { on = ($3 == "a/" f) ; next }
		on && /^\+\+\+ / { next }
		on && /^\+/ { print substr($0, 2) }
	' "$PATCH"
}

# Public stat fields (switch_types.h hunk), private tracker state (struct switch_rtp hunk:
# the qt_* member lines), tracker functions (between the BEGIN/END markers).
added_lines src/include/switch_types.h > "$OUT/qt_fields_public.inc"
added_lines src/switch_rtp.c | awk '/RCF quality patch v1 — tracker state/{on=1;next} on&&/^\t(uint|int|double)/{print;next} on{exit}' > "$OUT/qt_fields_private.inc"
added_lines src/switch_rtp.c | awk '/RCF-QPATCH-TRACKER-BEGIN/{on=1} on{print} /RCF-QPATCH-TRACKER-END/{on=0}' \
	| sed 's/defined(__linux__)/defined(QT_TEST_KERNEL)/' > "$OUT/qt_tracker.inc"

for f in qt_fields_public.inc qt_fields_private.inc qt_tracker.inc; do
	[ -s "$OUT/$f" ] || { echo "extraction failed: $f is empty" >&2; exit 1; }
done
echo "extracted: $(wc -l < "$OUT/qt_fields_public.inc") public field lines, $(wc -l < "$OUT/qt_fields_private.inc") private field lines, $(wc -l < "$OUT/qt_tracker.inc") tracker lines"

FLAGS="-std=gnu99 -O2 -Wall -Wextra -Werror -Wdeclaration-after-statement -Wno-unused-function -I$HERE -I$OUT"
$CC $FLAGS -o "$OUT/t_read" "$HERE/qt_tracker_test.c" -lm
$CC $FLAGS -DQT_TEST_KERNEL -o "$OUT/t_kernel" "$HERE/qt_tracker_test.c" -lm
"$OUT/t_read"
"$OUT/t_kernel"
echo "unit: PASS"
