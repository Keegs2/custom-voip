#!/bin/sh
# Piper TTS wrapper for FreeSWITCH mod_tts_commandline (Phase 7).
#
# Invoked by tts_commandline.conf.xml as:
#   piper_tts.sh <outfile.wav> <rate> <voice> <text>
#
# mod_tts_commandline passes every ${...} token through switch_util_quote_shell_arg(),
# so each argument arrives SHELL-SAFE and <text> is a SINGLE argument even when it
# contains spaces or shell metacharacters — there is NO injection path from
# customer-supplied <Say> text. (Verified in mod_tts_commandline.c: speech_feed_tts.)
#
# We synthesize <text> with Piper (neural, offline, MIT) to <outfile.wav>.
# Piper medium voices emit a 16-bit mono WAV at 22050 Hz; FreeSWITCH (mod_sndfile)
# reads the native rate from the WAV header and RESAMPLES to the call rate, so the
# <rate> argument is informational here (Piper's rate is fixed by the model).
#
# On any failure this exits non-zero: mod_tts_commandline then logs the failed
# command and handlers/api_voice.lua falls back to say:PRONOUNCED (no hard failure).
set -eu

OUTFILE="${1:-}"
RATE="${2:-}"      # session rate (e.g. 8000); informational — see header note
VOICE="${3:-}"
TEXT="${4:-}"

PIPER_DIR="${PIPER_DIR:-/opt/piper}"
PIPER_BIN="${PIPER_BIN:-$PIPER_DIR/piper}"
VOICES_DIR="${PIPER_VOICES_DIR:-$PIPER_DIR/voices}"
DEFAULT_MODEL="${PIPER_DEFAULT_MODEL:-en_US-lessac-medium}"
ESPEAK_DATA="${PIPER_ESPEAK_DATA:-$PIPER_DIR/espeak-ng-data}"
LOG="${PIPER_LOG:-/tmp/piper_tts.log}"

if [ -z "$OUTFILE" ] || [ -z "$TEXT" ]; then
  echo "$(date '+%F %T') piper_tts: missing outfile/text (out='$OUTFILE')" >>"$LOG"
  exit 2
fi

# Map a requested <Say voice="..."> token to a Piper model (basename, no extension).
# We ship ONE voice today, so everything resolves to en_US-lessac-medium. To add
# voices: drop <name>.onnx + <name>.onnx.json into $VOICES_DIR and add a case here.
# The api_voice.lua engine passes the raw requested voice through for non-flite
# engines (man/woman/alice/Polly.* etc. are flite-isms), so unknown tokens fall
# back to DEFAULT_MODEL rather than failing the render.
case "$(printf '%s' "$VOICE" | tr '[:upper:]' '[:lower:]')" in
  en_us-lessac-medium|lessac|alice|woman|female|slt|"") MODEL="en_US-lessac-medium" ;;
  *)                                                     MODEL="$DEFAULT_MODEL" ;;
esac

MODEL_PATH="$VOICES_DIR/$MODEL.onnx"
[ -f "$MODEL_PATH" ] || MODEL_PATH="$VOICES_DIR/$DEFAULT_MODEL.onnx"

# onnxruntime + piper_phonemize shared objects live alongside the piper binary.
export LD_LIBRARY_PATH="$PIPER_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# Piper reads the text to speak on stdin and writes the WAV to --output_file.
printf '%s' "$TEXT" | "$PIPER_BIN" \
  --model "$MODEL_PATH" \
  --espeak_data "$ESPEAK_DATA" \
  --output_file "$OUTFILE" >>"$LOG" 2>&1
