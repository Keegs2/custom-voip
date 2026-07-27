# secrets/ — host-mounted credentials (NOT committed)

Everything in this directory is git-ignored except this README and the
`gcp-monitoring-sa.json` placeholder (see `.gitignore`).

## gcp-monitoring-sa.json — unused placeholder (auth is keyless — see below)

This file is a tracked **placeholder** and is **NOT mounted anywhere**. The
`gcp-monitoring` Grafana datasource
(`docker/homer/grafana/provisioning/datasources/gcp-monitoring.yml`) authenticates
to GCP Cloud Monitoring via **keyless GCE metadata auth**, not a key file — see
below. The placeholder is kept only so the git tree / `.gitignore` entries stay
stable.

### Auth is KEYLESS (GCE metadata) — no key file, no GCM_SA_EMAIL

The org enforces `constraints/iam.managed.disableServiceAccountKeyCreation`, so
downloadable SA keys **cannot** be created. The `gcp-monitoring` datasource
therefore uses **GCE metadata auth**: Grafana borrows the `services` VM's
attached service account via the metadata server. Setup is one IAM grant — no
key, no `GCM_SA_EMAIL`, no volume mount:

```
gcloud projects add-iam-policy-binding rugged-night-193017 --member "serviceAccount:562404538544-compute@developer.gserviceaccount.com" --role roles/monitoring.viewer --condition=None
```

Prereqs (already satisfied on `services`): the VM's attached SA has
`roles/monitoring.viewer` and the `cloud-platform` (or `monitoring`) access
scope. Then restart Grafana:
`sudo docker compose -f docker-compose.services.yml up -d grafana`.

`gcp-monitoring-sa.json` here is now an **unused placeholder** (kept only so the
git tree / `.gitignore` are unchanged; nothing mounts it). If your org ever
permits SA keys, the key-file (jwt) path is documented in the header of
`docker/homer/grafana/provisioning/datasources/gcp-monitoring.yml`.
