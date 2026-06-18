# Dev-only seed / maintenance scripts

These are NOT in `init/` and do NOT run automatically on `initdb`. Run them by
hand against a dev database only.

- `21_account_cleanup.sql` — DESTRUCTIVE demo reset: replaces test customers 1-5
  and rewrites their RCF numbers. NEVER run in production. It assumes the legacy
  demo seed (old `06_seed_data.sql` customers 1-5) exists; on the hardened RCF-V1
  base those don't exist, so it errors mid-script. Production uses
  `init/14_granite_accounts.sql` for the real Granite seed instead.

  Manual run:  psql -U voip -d voip -f docker/postgres/dev-seed/21_account_cleanup.sql
