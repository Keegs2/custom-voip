"""Visual IVR product logic (contract docs/IVR_INTERFACES.md; plan docs/IVR_PRODUCT_PLAN.md §5).

  compiler.py  graph (§2) -> plan (§3) + Issue list   — pure, the ONLY plan writer
  policy.py    dial policy (§6): US-only NPA tables, own-number + self-transfer rules
  simulator.py "what the caller hears" walk of a plan  — pure
  audio.py     canonical 8 kHz mono PCM16 WAV + sha256 (§4)
  tts.py       Piper sidecar client (§8.1), render cache, preview rate limit
  store.py     shared SQL / shapes / number-inventory assign (routers/ivr.py, number_inventory.py)
  limits.py    every bound the API enforces
"""
