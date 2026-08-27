# realuptime: check monitor status

A composite GitHub Action that checks one or more of your
[realuptime](https://realuptime.io) monitors and fails the workflow (or just
reports outputs) based on their current status. It calls the same public REST
API documented at [realuptime.io/docs/api](https://realuptime.io/docs/api) --
no extra service, no polling infrastructure to run yourself.

Requires a Growth or Scale plan API key. The REST API and MCP server are paid
features; see [realuptime.io/pricing](https://realuptime.io/pricing).

This repository is a read-only publish surface and its history is rewritten
on release. For questions or problems, use the docs at
[realuptime.io/docs/github-action](https://realuptime.io/docs/github-action)
or contact support@realuptime.io; pull requests here cannot be merged.

## Usage

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      # ... your deploy steps ...

      - name: Confirm production is healthy before finishing
        uses: RealUptimeHQ/check-status-action@v1
        with:
          api-key: ${{ secrets.REALUPTIME_API_KEY }}
          check-ids: "11111111-1111-1111-1111-111111111111"
```

Pin to a release tag (`@v1`) or a commit SHA, not `@main`.

### Checking multiple monitors

```yaml
- name: Confirm all regions are healthy
  uses: RealUptimeHQ/check-status-action@v1
  with:
    api-key: ${{ secrets.REALUPTIME_API_KEY }}
    check-ids: |
      11111111-1111-1111-1111-111111111111
      22222222-2222-2222-2222-222222222222
```

Find a monitor's id from the dashboard (each monitor's detail view) or by
calling `GET /checks` yourself:

```bash
curl https://realuptime.io/api/v1/checks -H "Authorization: Bearer ru_live_..."
```

### Reporting instead of failing

Set `fail-on: ""` to never fail the step, and read the `all_operational` /
`results` outputs yourself:

```yaml
- name: Check status
  id: check
  uses: RealUptimeHQ/check-status-action@v1
  with:
    api-key: ${{ secrets.REALUPTIME_API_KEY }}
    check-ids: "11111111-1111-1111-1111-111111111111"
    fail-on: ""

- name: Notify on partial degradation
  if: steps.check.outputs.all_operational == 'false'
  run: echo "Degraded: ${{ steps.check.outputs.results }}"
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | | A realuptime API key, Growth or Scale plan. `read` scope is enough (this action never mutates anything). Store as a secret, never inline. |
| `check-ids` | yes | | One or more monitor ids, comma- or newline-separated. |
| `fail-on` | no | `down,degraded` | Comma-separated statuses that fail the step: `operational`, `degraded`, `down`, `stale`, `unknown`. Pass `""` to never fail and only report outputs. |
| `base-url` | no | `https://realuptime.io/api/v1` | Override for testing against a non-production instance. |

## Outputs

| Output | Description |
|---|---|
| `all_operational` | `"true"` if every checked monitor's status was outside the `fail-on` list, `"false"` otherwise. |
| `failure_count` | Number of monitors that errored or matched a `fail-on` status. |
| `results` | JSON array, one entry per checked monitor: `{ checkId, ok, name?, url?, status?, error? }`. |

## Status meanings

| Status | Meaning |
|---|---|
| `operational` | No fresh region reports down. |
| `degraded` | Some fresh regions report down, or full down-coverage isn't confirmed yet. |
| `down` | All of the monitor's selected regions are fresh and reporting down. |
| `stale` | Every region has reported at least once, but none recently (over 3 minutes old). |
| `unknown` | No region has ever reported for this monitor. |

`stale` and `unknown` are excluded from the default `fail-on` list because
they mean "we don't have fresh data," not a confirmed outage.

## Rate limits and scope

One `GET /checks/:id` request per `check-ids` entry per run, against a
120/minute read budget per API key. A `read`-scope API key is sufficient
and recommended, since this action never creates, updates, or deletes a
monitor.

## License

MIT, see [LICENSE](./LICENSE).
