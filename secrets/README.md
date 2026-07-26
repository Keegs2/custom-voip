# secrets/ — host-mounted credentials (NOT committed)

Everything in this directory is git-ignored except this README and the
`gcp-monitoring-sa.json` placeholder (see `.gitignore`).

## gcp-monitoring-sa.json — GCP Monitoring service-account key

Mounted read-only into the Grafana container at
`/etc/grafana/gcp/gcp-monitoring-sa.json` (see the `grafana` service in
`docker-compose.services.yml`). The `gcp-monitoring` Grafana datasource
(`docker/homer/grafana/provisioning/datasources/gcp-monitoring.yml`) reads the
`private_key` field from it via `privateKeyPath`.

The version in git is a **placeholder** so the docker bind-mount target is a
file, not an auto-created directory. On the **services VM** the operator
replaces its contents with a real downloaded GCP service-account JSON key.

### One-time setup (operator, on the services VM — project rugged-night-193017)

```
gcloud iam service-accounts create grafana-noc-monitoring --project rugged-night-193017 --display-name "Grafana NOC read-only monitoring"
gcloud projects add-iam-policy-binding rugged-night-193017 --member "serviceAccount:grafana-noc-monitoring@rugged-night-193017.iam.gserviceaccount.com" --role roles/monitoring.viewer
gcloud iam service-accounts keys create /opt/revup/secrets/gcp-monitoring-sa.json --iam-account grafana-noc-monitoring@rugged-night-193017.iam.gserviceaccount.com
chmod 600 /opt/revup/secrets/gcp-monitoring-sa.json
```

Then set in `/opt/revup/.env`:

```
GCM_SA_EMAIL=grafana-noc-monitoring@rugged-night-193017.iam.gserviceaccount.com
```

and restart Grafana: `sudo docker compose -f docker-compose.services.yml up -d grafana`.

### Alternative: no key file (GCE metadata auth)

If you attach an SA with `roles/monitoring.viewer` to the `services` VM and its
access scope includes Cloud Monitoring, you can switch
`gcp-monitoring.yml` to `authenticationType: gce` and delete this key + the
compose volume mount. See the header of that datasource file.
