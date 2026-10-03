#!/usr/bin/env node
// SEO Autopilot: workflow helper. Zero dependencies, Node 20+, ESM.
//
// Fetches the signed batch spec, sends signed callbacks to the app, checks the
// commits Claude Code made, and builds the pull request body. Used by
// .github/workflows/seo-autopilot.yml so the YAML stays readable.
//
// Commands:
//   fetch-spec   --url <spec_url> --batch-id <id> --private-out <file> --public-out <file>
//   send         <event> [--data <json>] [--data-file <file>]
//   items        --base <ref> --results <file> --out <file>
//   qa-result    --file <qa json>
//   pr-body      --items <file> --qa <file> --out <file>   (prints the PR title)
//   pr-opened    --url <pr url>
//   failed       (reads step outcomes from the environment)
//
// Environment:
//   SEO_AUTOPILOT_CALLBACK_SECRET  HMAC secret (org-level Actions secret)
//   SEO_SPEC_PATH                  path to the private spec copy (has the callback token)
//   SEO_BATCH_ID, SEO_SPEC_URL     workflow inputs (used when the spec could not be fetched)
//   GITHUB_*                       standard Actions variables

import { createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const EVENTS = new Set(["started", "item_done", "qa_result", "pr_opened", "failed"]);
const LOG_EXCERPT_MAX = 4000;

// ---------------------------------------------------------------------------
// small utilities

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function log(msg) {
  process.stderr.write(`[seo-autopilot] ${msg}\n`);
}

function die(msg) {
  // ::error:: makes the message visible in the Actions UI and in our step log.
  process.stdout.write(`::error::${msg.replace(/\r?\n/g, " ")}\n`);
  process.exit(1);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`Missing environment variable ${name}`);
  return v;
}

function writeFileEnsuringDir(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const str = String(value);
  if (!file) {
    log(`output ${name}=${str}`);
    return;
  }
  if (str.includes("\n")) {
    const delim = `EOF_${Math.random().toString(36).slice(2)}`;
    appendFileSync(file, `${name}<<${delim}\n${str}\n${delim}\n`);
  } else {
    appendFileSync(file, `${name}=${str}\n`);
  }
}

function mask(value) {
  if (value) process.stdout.write(`::add-mask::${value}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function hmacHex(secret, message) {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function nowSeconds() {
  return String(Math.floor(Date.now() / 1000));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function runUrl() {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const id = process.env.GITHUB_RUN_ID || "";
  return `${server}/${repo}/actions/runs/${id}`;
}

function runId() {
  // GitHub run IDs are numeric and fit within Number.MAX_SAFE_INTEGER.
  const n = Number(process.env.GITHUB_RUN_ID || 0);
  return Number.isSafeInteger(n) ? n : String(process.env.GITHUB_RUN_ID);
}

function runAttempt() {
  return process.env.GITHUB_RUN_ATTEMPT || "1";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSpec() {
  const path = process.env.SEO_SPEC_PATH;
  if (!path || !existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP with retry

async function requestWithRetry(makeRequest, { label, attempts = 4 }) {
  // 1 initial attempt + 3 retries, backoff 2s, 4s, 8s.
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await makeRequest();
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      lastError = `${label}: HTTP ${res.status} ${text.slice(0, 300)}`;
      // 409 means the app already has this idempotency key: treat as delivered.
      if (res.status === 409) return res;
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      if (!retryable) break;
    } catch (err) {
      lastError = `${label}: ${err?.message || err}`;
    }
    if (attempt < attempts) {
      const wait = 2000 * 2 ** (attempt - 1);
      log(`${lastError} (attempt ${attempt}/${attempts}); retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new Error(lastError || `${label}: request failed`);
}

// ---------------------------------------------------------------------------
// fetch-spec

function validateSpec(spec, batchId) {
  const problems = [];
  const str = (k) => typeof spec[k] === "string" && spec[k].length > 0;
  for (const k of ["batch_id", "short_id", "branch", "base_branch", "callback_url", "callback_token"]) {
    if (!str(k)) problems.push(`missing ${k}`);
  }
  if (spec.batch_id && String(spec.batch_id) !== String(batchId)) problems.push("batch_id does not match the workflow input");
  if (!Array.isArray(spec.items) || spec.items.length === 0) problems.push("items must be a non-empty array");
  else {
    const refs = new Set();
    spec.items.forEach((it, i) => {
      if (!it || typeof it !== "object") return problems.push(`items[${i}] is not an object`);
      if (!it.opportunity_id) problems.push(`items[${i}].opportunity_id missing`);
      if (!it.ref || !/^[A-Za-z0-9._-]+$/.test(String(it.ref))) problems.push(`items[${i}].ref missing or invalid`);
      if (refs.has(it.ref)) problems.push(`duplicate ref ${it.ref}`);
      refs.add(it.ref);
      if (!it.title) problems.push(`items[${i}].title missing`);
    });
  }
  if (!Array.isArray(spec.guardrails)) problems.push("guardrails must be an array");
  for (const b of [spec.branch, spec.base_branch]) {
    if (typeof b === "string") {
      try {
        execFileSync("git", ["check-ref-format", "--branch", b], { stdio: "ignore" });
      } catch {
        problems.push(`invalid branch name ${JSON.stringify(b)}`);
      }
    }
  }
  return problems;
}

async function cmdFetchSpec(flags) {
  const secret = requireEnv("SEO_AUTOPILOT_CALLBACK_SECRET");
  const url = flags.url;
  const batchId = flags["batch-id"];
  if (!url || !batchId) die("fetch-spec needs --url and --batch-id");
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) die("spec_url must be https");

  const res = await requestWithRetry(
    () => {
      const ts = nowSeconds();
      return fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-SEO-Autopilot-Timestamp": ts,
          "X-SEO-Autopilot-Signature": hmacHex(secret, `${ts}.${batchId}`),
        },
        signal: AbortSignal.timeout(20000),
      });
    },
    { label: "GET spec" },
  );
  let spec;
  try {
    spec = await res.json();
  } catch {
    die("Spec response was not valid JSON");
  }
  mask(spec.callback_token);
  const problems = validateSpec(spec, batchId);
  if (problems.length) die(`Spec is invalid: ${problems.join("; ")}`);

  spec.qa = {
    max_changed_lines: Number(spec.qa?.max_changed_lines) || 1500,
    similarity_threshold: Number(spec.qa?.similarity_threshold) || 0.8,
  };

  // The private copy keeps the callback token. Claude Code only gets the public copy.
  writeFileEnsuringDir(flags["private-out"], JSON.stringify(spec, null, 2));
  const { callback_url, callback_token, ...publicSpec } = spec;
  writeFileEnsuringDir(flags["public-out"], JSON.stringify(publicSpec, null, 2));

  const n = spec.items.length;
  setOutput("branch", spec.branch);
  setOutput("base_branch", spec.base_branch);
  setOutput("short_id", spec.short_id);
  setOutput("item_count", n);
  // Generous turn budget: a fixed overhead plus room per item.
  setOutput("max_turns", Math.min(30 + 40 * n, 400));
  log(`Spec OK: batch ${spec.short_id}, ${n} item(s), ${spec.base_branch} -> ${spec.branch}`);
}

// ---------------------------------------------------------------------------
// callbacks

function fallbackCallbackUrl() {
  // Used only if the spec could not be fetched. The app's convention is
  // spec_url = {APP_URL}/api/github-callback/spec/{batch_id}
  // callback  = {APP_URL}/api/github-callback/{batch_id}
  const specUrl = process.env.SEO_SPEC_URL || "";
  const batchId = process.env.SEO_BATCH_ID || "";
  const m = specUrl.match(/^(.*)\/spec\/([^/?#]+)\/?(?:[?#].*)?$/);
  if (m && (!batchId || m[2] === batchId)) return `${m[1]}/${m[2]}`;
  return null;
}

export function idempotencyKey(event, opportunityId) {
  const base = `${process.env.GITHUB_RUN_ID}:${runAttempt()}:${event}`;
  return event === "item_done" ? `${base}:${opportunityId}` : base;
}

async function sendEvent(event, data, { bestEffort = false } = {}) {
  if (!EVENTS.has(event)) die(`Unknown event ${event}`);
  const secret = requireEnv("SEO_AUTOPILOT_CALLBACK_SECRET");
  const spec = loadSpec();
  const url = spec?.callback_url || (bestEffort ? fallbackCallbackUrl() : null);
  if (!url) {
    const msg = `No callback_url available; cannot send ${event}`;
    if (bestEffort) return log(msg);
    die(msg);
  }
  const body = JSON.stringify({
    event,
    idempotency_key: idempotencyKey(event, data?.opportunity_id),
    run_id: runId(),
    run_url: runUrl(),
    data: data ?? {},
  });

  try {
    await requestWithRetry(
      () => {
        const ts = nowSeconds();
        const headers = {
          "Content-Type": "application/json",
          "X-SEO-Autopilot-Timestamp": ts,
          "X-SEO-Autopilot-Signature": hmacHex(secret, `${ts}.${body}`),
        };
        if (spec?.callback_token) headers["X-SEO-Autopilot-Token"] = spec.callback_token;
        return fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(20000) });
      },
      { label: `POST ${event}` },
    );
    log(`Sent ${event}${data?.opportunity_id ? ` (${data.opportunity_id})` : ""}`);
  } catch (err) {
    if (bestEffort) return log(`Could not send ${event}: ${err.message}`);
    die(`Could not send ${event} callback: ${err.message}`);
  }
}

async function cmdSend(positional, flags) {
  const event = positional[0];
  let data = {};
  if (flags["data-file"]) data = readJson(flags["data-file"]);
  else if (typeof flags.data === "string") data = JSON.parse(flags.data);
  await sendEvent(event, data);
}

// ---------------------------------------------------------------------------
// items: verify commits, reconcile with Claude's results, send item_done

const PROTECTED_PATHS = [/^\.seo-autopilot\//, /^\.github\//];

export function parseCommitSubject(subject, knownRefs) {
  const m = /^seo: (.+) \[([^\]]+)\]$/.exec(subject.trim());
  if (!m) return null;
  if (!knownRefs.has(m[2])) return null;
  return { title: m[1], ref: m[2] };
}

export function reconcileItems(items, commits, results) {
  const byRef = new Map(commits.map((c) => [c.ref, c]));
  const resultById = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (r && r.opportunity_id) resultById.set(String(r.opportunity_id), r);
  }
  return items.map((it) => {
    const commit = byRef.get(it.ref);
    const reported = resultById.get(String(it.opportunity_id));
    if (commit) {
      const out = { opportunity_id: it.opportunity_id, status: "done", commit_sha: commit.sha };
      if (reported?.status === "skipped") out.reason = `Committed, although Claude Code reported it as skipped: ${reported.reason || "no reason given"}`;
      return out;
    }
    let reason;
    if (reported?.status === "skipped") reason = reported.reason || "Skipped by Claude Code (no reason given)";
    else if (reported?.status === "done") reason = "Claude Code reported this as done but no matching commit was found";
    else reason = "No result was reported by Claude Code and no matching commit was found";
    return { opportunity_id: it.opportunity_id, status: "skipped", reason: String(reason).slice(0, 1000) };
  });
}

async function cmdItems(flags) {
  const spec = loadSpec();
  if (!spec) die("Spec not available");
  const base = flags.base;
  if (!base) die("items needs --base");

  const knownRefs = new Set(spec.items.map((i) => i.ref));
  const raw = git(["log", "--reverse", "--format=%H%x1f%s", `${base}..HEAD`]);
  const lines = raw ? raw.split("\n") : [];
  const commits = [];
  const problems = [];
  const seen = new Set();
  for (const line of lines) {
    const [sha, subject] = line.split("\x1f");
    const parsed = parseCommitSubject(subject || "", knownRefs);
    if (!parsed) {
      problems.push(`commit ${sha.slice(0, 7)} has an unexpected message: ${JSON.stringify(subject)}`);
      continue;
    }
    if (seen.has(parsed.ref)) problems.push(`more than one commit for ${parsed.ref}`);
    seen.add(parsed.ref);
    commits.push({ sha, ref: parsed.ref, subject });
  }

  // Claude Code must never touch the workflow or the QA tooling.
  const changed = git(["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
  const touched = changed.filter((p) => PROTECTED_PATHS.some((re) => re.test(p)));
  if (touched.length) problems.push(`protected files were changed: ${touched.join(", ")}`);

  if (problems.length) die(`Commit check failed: ${problems.join("; ")}`);

  let results = [];
  if (flags.results && existsSync(flags.results)) {
    try {
      results = readJson(flags.results);
    } catch (e) {
      log(`Results file is not valid JSON (${e.message}); relying on git log only`);
    }
  } else log("No results file from Claude Code; relying on git log only");

  const reconciled = reconcileItems(spec.items, commits, results);
  for (const r of reconciled) await sendEvent("item_done", r);

  writeFileEnsuringDir(flags.out, JSON.stringify(reconciled, null, 2));
  const done = reconciled.filter((r) => r.status === "done").length;
  setOutput("commit_count", commits.length);
  setOutput("done_count", done);
  log(`${commits.length} commit(s); ${done} done, ${reconciled.length - done} skipped`);
}

// ---------------------------------------------------------------------------
// qa_result

async function cmdQaResult(flags) {
  let data;
  try {
    data = readJson(flags.file);
    if (typeof data.passed !== "boolean" || !Array.isArray(data.checks)) throw new Error("unexpected shape");
  } catch (e) {
    data = {
      passed: false,
      checks: [{ name: "qa_script", passed: false, detail: `qa.mjs did not produce valid results: ${e.message}` }],
    };
    writeFileEnsuringDir(flags.file, JSON.stringify(data, null, 2));
  }
  data.checks = data.checks.map((c) => ({ name: String(c.name), passed: !!c.passed, detail: String(c.detail ?? "") }));
  await sendEvent("qa_result", { passed: !!data.passed, checks: data.checks });
}

// ---------------------------------------------------------------------------
// PR body

export function formatDateEnGb(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(date);
}

function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function evidenceLine(e) {
  const parts = [`${e.source}: ${e.metric} = ${e.value}`];
  if (e.period) parts.push(`(${e.period})`);
  let line = parts.join(" ");
  if (e.note) line += ` — ${e.note}`;
  if (e.url) line += ` [source](${e.url})`;
  return line;
}

export function buildPrBody(spec, items, qa) {
  const byId = new Map(items.map((r) => [String(r.opportunity_id), r]));
  const done = spec.items.filter((it) => byId.get(String(it.opportunity_id))?.status === "done");
  const skipped = spec.items.filter((it) => byId.get(String(it.opportunity_id))?.status !== "done");
  const out = [];
  out.push(`Automated SEO changes for **${spec.client?.name ?? "this site"}**, batch \`${spec.short_id}\`.`);
  out.push("");
  out.push(`One commit per change. Review in the app: ${spec.app_batch_url}`);
  out.push("");
  out.push("## Changes");
  for (const it of done) {
    const r = byId.get(String(it.opportunity_id));
    out.push("");
    out.push(`### ${it.title} \`[${it.ref}]\``);
    if (it.target_url) out.push(`- **Page:** ${it.target_url}`);
    if (it.proposed_action) out.push(`- **Change:** ${String(it.proposed_action).replace(/\r?\n/g, " ")}`);
    if (r?.commit_sha) out.push(`- **Commit:** ${r.commit_sha}`);
    const ev = Array.isArray(it.evidence) ? it.evidence : [];
    if (ev.length) {
      out.push("- **Evidence:**");
      for (const e of ev) out.push(`  - ${evidenceLine(e)}`);
    }
  }
  if (skipped.length) {
    out.push("");
    out.push("## Skipped");
    for (const it of skipped) {
      const r = byId.get(String(it.opportunity_id));
      out.push(`- ${it.title} \`[${it.ref}]\`: ${r?.reason ?? "not reported"}`);
    }
  }
  out.push("");
  out.push("## SEO QA");
  out.push("");
  out.push(`Overall: **${qa.passed ? "passed" : "failed"}**`);
  out.push("");
  out.push("| Check | Result | Detail |");
  out.push("| --- | --- | --- |");
  for (const c of qa.checks) out.push(`| ${mdEscape(c.name)} | ${c.passed ? "pass" : "FAIL"} | ${mdEscape(c.detail).slice(0, 500)} |`);
  out.push("");
  out.push("---");
  out.push(`Generated by SEO Autopilot with Claude Code. A human must review and merge this PR. [Workflow run](${runUrl()}) · [Batch in the app](${spec.app_batch_url})`);
  return out.join("\n");
}

function cmdPrBody(flags) {
  const spec = loadSpec();
  if (!spec) die("Spec not available");
  const items = readJson(flags.items);
  const qa = readJson(flags.qa);
  const body = buildPrBody(spec, items, qa);
  writeFileEnsuringDir(flags.out, body);
  // The PR title is printed on stdout for the workflow to capture.
  process.stdout.write(prTitle(items.filter((r) => r.status === "done").length) + "\n");
}

export function prTitle(n, date = new Date()) {
  return `SEO Autopilot: ${n} ${n === 1 ? "change" : "changes"} (${formatDateEnGb(date)})`;
}

async function cmdPrOpened(flags) {
  const spec = loadSpec();
  const url = String(flags.url || "").trim();
  const m = /\/pull\/(\d+)/.exec(url);
  if (!m) die(`Could not read the PR number from ${JSON.stringify(url)}`);
  await sendEvent("pr_opened", { pr_number: Number(m[1]), pr_url: url, branch: spec?.branch });
}

// ---------------------------------------------------------------------------
// failed

function tail(text, max) {
  return text.length > max ? text.slice(text.length - max) : text;
}

function claudeExcerpt(executionFile) {
  // The action's execution file is a JSON array of SDK messages; the last
  // "result" message says why Claude Code stopped.
  try {
    const msgs = readJson(executionFile);
    const result = [...msgs].reverse().find((m) => m?.type === "result");
    if (result) {
      return JSON.stringify({ subtype: result.subtype, is_error: result.is_error, num_turns: result.num_turns, result: result.result }, null, 2);
    }
  } catch {}
  return "";
}

export function pickFailedStep(order, outcomes) {
  for (const id of order) if (outcomes[id] === "failure") return id;
  return null;
}

async function cmdFailed() {
  const order = (process.env.SEO_STEP_ORDER || "").split(",").map((s) => s.trim()).filter(Boolean);
  const outcomes = {};
  for (const id of order) outcomes[id] = process.env[`OUTCOME_${id}`] || "";
  const failed = pickFailedStep(order, outcomes);
  const logDir = process.env.SEO_LOG_DIR || "";

  let step = failed || "cancelled";
  let message;
  let excerpt = "";
  if (!failed) {
    message = "The workflow run was cancelled or timed out before it finished.";
  } else {
    const logPath = `${logDir}/${failed}.log`;
    if (logDir && existsSync(logPath)) excerpt = readFileSync(logPath, "utf8");
    if (failed === "claude" && process.env.CLAUDE_EXECUTION_FILE) excerpt = claudeExcerpt(process.env.CLAUDE_EXECUTION_FILE) || excerpt;
    // Strip ANSI colour codes.
    excerpt = excerpt.replace(/\x1b\[[0-9;]*m/g, "");
    const errLine = excerpt
      .split("\n")
      .reverse()
      .find((l) => /::error::|error|failed|fail\b/i.test(l));
    message = errLine ? errLine.replace(/^.*::error::/, "").trim().slice(0, 500) : `Step "${failed}" failed.`;
  }
  await sendEvent("failed", { step, message, log_excerpt: tail(excerpt, LOG_EXCERPT_MAX) }, { bestEffort: true });
}

// ---------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case "fetch-spec":
      return cmdFetchSpec(flags);
    case "send":
      return cmdSend(positional, flags);
    case "items":
      return cmdItems(flags);
    case "qa-result":
      return cmdQaResult(flags);
    case "pr-body":
      return cmdPrBody(flags);
    case "pr-opened":
      return cmdPrOpened(flags);
    case "failed":
      return cmdFailed();
    default:
      die(`Unknown command ${cmd ?? "(none)"}`);
  }
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("callback.mjs");
if (invokedDirectly) {
  main().catch((err) => die(err?.stack || String(err)));
}
