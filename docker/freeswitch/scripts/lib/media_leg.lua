-- lib/media_leg.lua — per-leg media clocking for legs FreeSWITCH TERMINATES.
--
-- Contract: docs/IVR_INTERFACES.md §5.3; plan §7.2. The values are the ones
-- lib/vm_box.lua uses for the voicemail recording leg (vm_box.lua
-- M.RTP_TIMER_NAME / M.JITTERBUFFER, set just before its answer; owner
-- decision O6). vm_box is NOT switched to this module in the IVR project, to
-- avoid cross-PR coupling (contract §0) — keep the two in sync until it is.
--
-- WHY: neither sofia profile sets `rtp-timer-name` and mod_sofia has no
-- default, so RTP sessions are created without a timer and reads are paced by
-- packet arrival (docker/freeswitch/CLAUDE.md gotcha 13). That is right for
-- the bridged RCF/trunk relay legs and wrong for a leg FS plays prompts to and
-- collects DTMF from: prompt pacing and the jitter buffer both need a clock.
-- FS reads both variables only when the answer (or pre-answer) creates the RTP
-- session (switch_core_media_activate_rtp), so prepare() MUST run before
-- session:answer(). Setting them later has no effect.
--
-- SCOPE: only terminate_ivr calls this (contract §5.3). NEVER set
-- rtp-timer-name on a sofia profile to get this: that would change the RTP
-- pacing of every RCF/trunk relay leg. To verify on a node: an IVR CDR in
-- /var/log/freeswitch/json_cdr carries rtp_use_timer_name=soft; an RCF CDR
-- has none.
--
-- Loaded with the house loadfile() pattern. Lua 5.3-compatible.

local M = {}

M.RTP_TIMER_NAME = "soft"     -- one RTP read per ptime (vm_box.lua M.RTP_TIMER_NAME)
M.JITTERBUFFER   = "60:200"   -- jitterbuffer_msec: 60 ms start, 200 ms max (vm_box.lua M.JITTERBUFFER)

-- prepare(session) -> true, or false when the session refused the variables.
-- Never raises (a media nicety must never fail a call).
function M.prepare(session)
    if not session then return false end
    local ok = pcall(function()
        session:setVariable("rtp_timer_name", M.RTP_TIMER_NAME)
        session:setVariable("jitterbuffer_msec", M.JITTERBUFFER)
    end)
    return ok
end

return M
