#!/usr/bin/env node
/**
 * Build force and produce a hub-ready artifact under `dist/`.
 *
 *   dist/
 *   ├── index.html / assets / stockfish / textures / ui / gltf / audio / ...
 *   └── journal/
 *       ├── session.jsonl         (copied from .claude/journal/session-{id}.jsonl)
 *       ├── stats.json            (aggregated from multiple sources)
 *       └── checkpoints/<flat>    (copied from .claude/journal/checkpoints/{id}/)
 *
 * Intended to be consumed by iwsdk-adventures: one invocation → one artifact
 * that gets dropped wholesale into `public/apps/force/`.
 *
 * Usage:
 *   pnpm package:hub
 *   node scripts/package-for-hub.mjs [--session-id <uuid>] [--base /path/] \
 *                                    [--home-dir /Users/x] [--slug force]
 */

import { spawn } from "node:child_process";
import {
  cp,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { base: "/apps/force/", slug: "force", homeDir: os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-id") out.sessionId = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--home-dir") out.homeDir = argv[++i];
    else if (a === "--slug") out.slug = argv[++i];
  }
  return out;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function latestSessionId(journalDir) {
  const files = (await readdir(journalDir)).filter(
    (f) => f.startsWith("session-") && f.endsWith(".jsonl"),
  );
  if (files.length === 0) throw new Error(`no session-*.jsonl in ${journalDir}`);
  const withStats = await Promise.all(
    files.map(async (f) => {
      const p = path.join(journalDir, f);
      const { mtimeMs } = await (await import("node:fs/promises")).stat(p);
      return { p, f, mtimeMs };
    }),
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].f.replace(/^session-|\.jsonl$/g, "");
}

async function loadJsonl(file) {
  if (!existsSync(file)) return null;
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`  WARN: could not read ${file}: ${err.message}`);
    return null;
  }
}

async function countPromptsFromHistory(sessionId, homeDir) {
  const file = path.join(homeDir, ".claude", "history.jsonl");
  const rows = await loadJsonl(file);
  if (!rows) return null;
  return rows.filter((r) => {
    const sid = r.session_id ?? r.sessionId ?? r.session ?? null;
    return sid === sessionId;
  }).length;
}

/** Claude Code writes its project transcripts under
 *  ~/.claude/projects/-<cwd-with-slashes-replaced-by-dashes>/<session_id>.jsonl */
function transcriptPathFor(sessionId, cwd, homeDir) {
  const dirKey = cwd.replace(/[\\/]/g, "-");
  return path.join(homeDir, ".claude", "projects", dirKey, `${sessionId}.jsonl`);
}

async function analyzeTranscript(transcriptFile) {
  const rows = await loadJsonl(transcriptFile);
  if (!rows) return null;
  let assistantText = 0;
  const turnDurations = [];
  for (const r of rows) {
    if (r.type === "assistant") {
      const msg = r.message ?? {};
      const contents = Array.isArray(msg.content) ? msg.content : [];
      const hasText = contents.some(
        (c) => c.type === "text" && (c.text ?? "").trim().length > 0,
      );
      if (hasText) assistantText += 1;
    }
    if (
      r.type === "system" &&
      r.subtype === "turn_duration" &&
      typeof r.durationMs === "number"
    ) {
      turnDurations.push(r.durationMs);
    }
    if (typeof r.turn_duration === "number") turnDurations.push(r.turn_duration);
    if (typeof r.turnDuration === "number") turnDurations.push(r.turnDuration);
  }
  return { assistantText, turnDurations };
}

async function analyzeJournal(journalFile) {
  const rows = await loadJsonl(journalFile);
  if (!rows) throw new Error(`required journal missing: ${journalFile}`);
  const meta = rows.find((r) => r.type === "session_meta");
  let toolCalls = 0;
  let checkpoints = 0;
  for (const r of rows) {
    if (r.type === "tool_call") {
      toolCalls += 1;
      if (r.checkpoint_path) checkpoints += 1;
    }
  }
  return { meta, toolCalls, checkpoints };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. Build the app at the desired base.
  console.log(`▶ vite build --base ${args.base}`);
  await run("npx", ["vite", "build", "--base", args.base], REPO);

  const distDir = path.join(REPO, "dist");
  if (!existsSync(distDir)) throw new Error(`expected build output at ${distDir}`);

  // 2. Resolve the session to package.
  const journalDir = path.join(REPO, ".claude", "journal");
  if (!existsSync(journalDir)) throw new Error(`no .claude/journal in ${REPO}`);
  const sessionId = args.sessionId ?? (await latestSessionId(journalDir));
  const journalFile = path.join(journalDir, `session-${sessionId}.jsonl`);
  if (!existsSync(journalFile)) throw new Error(`journal not found: ${journalFile}`);
  console.log(`▶ packaging session ${sessionId}`);

  // 3. Copy journal JSONL.
  const outJournalDir = path.join(distDir, "journal");
  await rm(outJournalDir, { recursive: true, force: true });
  await mkdir(outJournalDir, { recursive: true });
  await copyFile(journalFile, path.join(outJournalDir, "session.jsonl"));

  // 4. Flatten checkpoints.
  const srcCheckpoints = path.join(journalDir, "checkpoints", sessionId);
  const outCheckpoints = path.join(outJournalDir, "checkpoints");
  await mkdir(outCheckpoints, { recursive: true });
  if (existsSync(srcCheckpoints)) {
    const files = (await readdir(srcCheckpoints)).filter((f) => !f.startsWith("."));
    for (const f of files) {
      await copyFile(path.join(srcCheckpoints, f), path.join(outCheckpoints, f));
    }
    console.log(`  checkpoints: ${files.length} copied`);
  } else {
    console.warn(`  no checkpoints dir at ${srcCheckpoints}`);
  }

  // 5. Aggregate stats.
  const { meta, toolCalls, checkpoints } = await analyzeJournal(journalFile);
  if (!meta) throw new Error(`session_meta missing in ${journalFile}`);
  const promptCount = await countPromptsFromHistory(sessionId, args.homeDir);
  const transcriptFile = transcriptPathFor(sessionId, meta.cwd, args.homeDir);
  const transcript = await analyzeTranscript(transcriptFile);

  const stats = {
    slug: args.slug,
    session_id: sessionId,
    user_messages: promptCount ?? meta.user_messages,
    user_messages_source:
      promptCount !== null ? "history.jsonl" : "journal.session_meta (over-counts)",
    assistant_messages: transcript?.assistantText ?? null,
    assistant_messages_source: transcript
      ? "cc-transcript (text-bearing)"
      : "unavailable — edit stats.json manually",
    tool_calls: toolCalls,
    checkpoints,
    active_ms:
      transcript?.turnDurations && transcript.turnDurations.length > 0
        ? transcript.turnDurations.reduce((a, b) => a + b, 0)
        : null,
    active_ms_source:
      transcript?.turnDurations && transcript.turnDurations.length > 0
        ? "cc-transcript.turn_duration"
        : "unavailable — edit stats.json manually",
    turn_durations_ms: transcript?.turnDurations ?? [],
    model: meta.model,
    built_with: "Claude Code",
    started_at: meta.started_at,
    updated_at: meta.updated_at,
  };

  await writeFile(
    path.join(outJournalDir, "stats.json"),
    JSON.stringify(stats, null, 2) + "\n",
  );

  console.log(`✓ packaged:`, {
    user: stats.user_messages,
    assistant: stats.assistant_messages,
    tools: stats.tool_calls,
    checkpoints: stats.checkpoints,
    active_ms: stats.active_ms,
  });
  if (stats.user_messages_source.includes("over-counts")) {
    console.warn(
      `  WARN: history.jsonl unreadable (home=${args.homeDir}); user_messages is the over-counted fallback. Edit stats.json manually.`,
    );
  }
  if (stats.active_ms === null) {
    console.warn(
      `  WARN: turn_duration missing from ${transcriptFile}; active_ms must be filled manually.`,
    );
  }
  console.log(`✓ dist/ ready to drop into iwsdk-adventures/public/apps/${args.slug}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
