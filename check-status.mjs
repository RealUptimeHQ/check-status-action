#!/usr/bin/env node
// Core logic for the realuptime "Check monitor status" composite action
// (see action.yml in this directory). Kept as a standalone, dependency-free
// script (Node 22's built-in fetch, no npm package) so it is unit-testable
// in isolation (check-status.test.mjs) without spinning up the Actions
// runner, and so the action needs no build/install step for consumers.
//
// Inputs arrive as environment variables (the pattern action.yml's `env:`
// block uses to pass `with:` inputs to this script) rather than argv, so a
// consumer's workflow yaml maps 1:1 onto GitHub's own INPUT_* convention
// without this script needing to parse `--flag value` pairs itself.

/**
 * @typedef {"operational" | "degraded" | "down" | "stale" | "unknown"} CheckStatus
 */

/** Statuses that, by default, should NOT fail the workflow. Matches the
 * REST API's aggregateStatusForDisplay semantics (docs/api.md): "stale" and
 * "unknown" mean "we don't have fresh data," not "the target is confirmed
 * down," so failing on them by default would make the action noisy for a
 * check that's simply new or a probe fleet hiccup, rather than a real
 * customer-facing outage. */
const DEFAULT_FAILING_STATUSES = ["down", "degraded"];
const ALL_STATUSES = ["operational", "degraded", "down", "stale", "unknown"];

export class ConfigError extends Error {}

/**
 * @param {Record<string, string | undefined>} env
 */
export function parseConfig(env) {
  const apiKey = (env.INPUT_API_KEY ?? "").trim();
  if (!apiKey) throw new ConfigError("api-key input is required.");

  const checkIdsRaw = (env.INPUT_CHECK_IDS ?? "").trim();
  if (!checkIdsRaw) throw new ConfigError("check-ids input is required (comma or newline separated).");
  const checkIds = checkIdsRaw
    .split(/[\n,]/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (checkIds.length === 0) throw new ConfigError("check-ids input did not contain any monitor ids.");

  const baseUrl = (env.INPUT_BASE_URL ?? "https://realuptime.io/api/v1").trim().replace(/\/+$/, "");

  // undefined (input never set) means "use the default"; an explicit ""
  // (action.yml's documented way to opt out of failing entirely) means "no
  // statuses fail the run" -- these are deliberately different from each
  // other, not the same falsy case.
  const failOnRaw = env.INPUT_FAIL_ON;
  const failOn =
    failOnRaw === undefined
      ? DEFAULT_FAILING_STATUSES
      : failOnRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  for (const status of failOn) {
    if (!ALL_STATUSES.includes(status)) {
      throw new ConfigError(
        `fail-on contains an unknown status "${status}". Valid statuses: ${ALL_STATUSES.join(", ")}.`,
      );
    }
  }

  return { apiKey, checkIds, baseUrl, failOn };
}

/**
 * Fetches one check's current status from the REST API.
 * @param {{ baseUrl: string, apiKey: string, checkId: string, fetchImpl?: typeof fetch }} args
 */
export async function fetchCheckStatus({ baseUrl, apiKey, checkId, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/checks/${encodeURIComponent(checkId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (response.status === 404) {
    return { checkId, ok: false, error: "Monitor not found, or not owned by this API key's account." };
  }
  if (!response.ok) {
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      checkId,
      ok: false,
      error: body?.error ?? `Request failed with status ${response.status}.`,
    };
  }

  /** @type {{ check: { id: string, name: string, url: string }, status: CheckStatus }} */
  const body = await response.json();
  return { checkId, ok: true, name: body.check.name, url: body.check.url, status: body.status };
}

/**
 * Runs the full check: fetches every configured monitor's status and
 * decides whether the run should fail, per the fail-on statuses.
 * @param {{ baseUrl: string, apiKey: string, checkIds: string[], failOn: string[], fetchImpl?: typeof fetch }} args
 */
export async function runCheck({ baseUrl, apiKey, checkIds, failOn, fetchImpl = fetch }) {
  const results = await Promise.all(
    checkIds.map((checkId) => fetchCheckStatus({ baseUrl, apiKey, checkId, fetchImpl })),
  );

  const failures = results.filter((result) => !result.ok || failOn.includes(result.status));
  return { results, failures, allOperational: failures.length === 0 };
}

function formatSummaryLine(result) {
  if (!result.ok) return `- ${result.checkId}: ERROR (${result.error})`;
  return `- ${result.name} (${result.checkId}): ${result.status}`;
}

/**
 * Writes GITHUB_OUTPUT / GITHUB_STEP_SUMMARY files, matching the
 * documented Actions toolkit contract (append `key<<EOF\nvalue\nEOF\n` for
 * multiline values, `key=value` for single-line).
 * @param {{ results: Array<Record<string, unknown>>, failures: Array<Record<string, unknown>>, allOperational: boolean }} outcome
 * @param {{ writeFile: (path: string, content: string) => Promise<void>, githubOutputPath?: string, githubStepSummaryPath?: string }} io
 */
export async function writeGithubOutputs(outcome, io) {
  const { results, failures, allOperational } = outcome;

  if (io.githubOutputPath) {
    const delimiter = "ghadelimiter_realuptime_check_status";
    const lines = [
      `all_operational=${allOperational}`,
      `failure_count=${failures.length}`,
      `results<<${delimiter}`,
      JSON.stringify(results),
      delimiter,
      "",
    ];
    await io.writeFile(io.githubOutputPath, lines.join("\n"));
  }

  if (io.githubStepSummaryPath) {
    const summary = [
      "## realuptime check status",
      "",
      ...results.map(formatSummaryLine),
      "",
      allOperational ? "All monitors are within the allowed statuses." : `${failures.length} monitor(s) failed the check.`,
      "",
    ].join("\n");
    await io.writeFile(io.githubStepSummaryPath, summary);
  }
}

/**
 * Entry point used by action.yml's `run:` step. Exits non-zero (failing the
 * workflow step) when any monitor is in a fail-on status or errored, unless
 * the caller only wants outputs set (continue-on-error is the user's own
 * workflow's job, not this script's).
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, log?: (msg: string) => void, writeFile?: (path: string, content: string) => Promise<void>, exit?: (code: number) => void }} [overrides]
 */
export async function main(overrides = {}) {
  const env = overrides.env ?? process.env;
  const log = overrides.log ?? console.log;
  const exit = overrides.exit ?? process.exit;
  const writeFile = overrides.writeFile ?? (async (path, content) => {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, content);
  });

  let config;
  try {
    config = parseConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log(`::error::${err.message}`);
      exit(1);
      return;
    }
    throw err;
  }

  const outcome = await runCheck({ ...config, fetchImpl: overrides.fetchImpl });

  for (const result of outcome.results) {
    log(formatSummaryLine(result));
  }

  await writeGithubOutputs(outcome, {
    writeFile,
    githubOutputPath: env.GITHUB_OUTPUT,
    githubStepSummaryPath: env.GITHUB_STEP_SUMMARY,
  });

  if (!outcome.allOperational) {
    log(`::error::${outcome.failures.length} monitor(s) reported a status in the fail-on list, or errored.`);
    exit(1);
    return;
  }

  exit(0);
}

// Only auto-run when executed directly (`node check-status.mjs`), not when
// imported by the test suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
