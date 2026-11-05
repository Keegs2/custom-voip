# AGENTS.md

`CLAUDE.md` is this repository's rulebook for every agent, Codex included. Read it first, along with the `CLAUDE.md` in each directory you change (see the Component Map). Its "Working through TED OS" section describes the branch, check and deploy pipeline.

The rules that matter most, briefly:

- **Production telephony platform.** It is carrier-grade with no POC shortcuts. `RCF-V1` is the production branch and the default branch. Open every PR against it, never stacked on another feature branch.
- **Never run `gcloud`, `tofu`/`terraform` plan or apply, or `ssh`, and never touch GCP or the VMs.** Write repo files and paste-ready single-line commands for the Owner to run. The GCP project is shared with other teams.
- **Don't push, merge or deploy without the Owner's OK.** There is no staging: the Owner deploys by hand in maintenance windows.
- **Tests must actually run.** `cd docker/ui/app && npm run build` for the UI (never `tsc --noEmit`). Run `TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin python3 -m pytest tests -q -rs` for the API and the `tests/lua/*_harness.lua` files for Lua. A skipped test didn't run.
- **CDR export content** changes ship behind an opt-in flag that defaults off, with the off state byte-identical.
