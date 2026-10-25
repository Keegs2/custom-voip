"""Visual IVR Flow assistant, CRAG side (contract docs/IVR_ASSIST_INTERFACES.md).

The customer describes a call flow in plain English; CRAG asks TED for a
proposal (TED owns the single AI step — CRAG never talks to a model), validates
it with CRAG's own compiler, and the builder shows it for the customer to
accept. Nothing is written to the draft and nothing is published here.

  config.py      env (IVR_ASSIST_ENABLED, TED_BASE_URL, TED_IVR_ASSIST_TOKEN,
                 IVR_ASSIST_DAILY_PER_CUSTOMER, IVR_ASSIST_TED_TIMEOUT_SECONDS)
                 and the fixed bounds
  aliases.py     phone-number detection, [D<n>] / [N<n>] / [P<n>] alias tokens,
                 customer / spoken rendering (§4.1)               — pure
  graph.py       draft graph <-> alias graph (§4)                   — pure
  schema.py      the normative JSON Schemas (schemas/, byte copies of
                 docs/ivr_assist/) and a strict evaluator          — pure
  ted_client.py  POST {TED_BASE_URL}/api/triggers/crag/ivr-assist (§1, §1.1)
  pipeline.py    one job without a DB: request, propose, compile, <= 2 repairs
  jobs.py        the job in the API: ivr_assist_jobs state, the asyncio task,
                 caps, rate limit, read / outcome / simulate support
  eval.py        ``python -m services.ivr.assist.eval`` — the owner's eval
                 runner against TED (no DB; synthetic context per case)
"""
