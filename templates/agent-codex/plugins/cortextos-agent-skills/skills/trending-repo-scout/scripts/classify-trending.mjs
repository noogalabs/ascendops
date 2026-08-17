#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const USAGE = "usage: classify-trending.mjs <candidates.json> <seen.json> [output.json]";
const MODEL = process.env.TRENDING_SCOUT_CLASSIFIER_MODEL || "haiku";
const MAX_BUDGET_USD = process.env.TRENDING_SCOUT_CLASSIFIER_MAX_BUDGET_USD || "0.50";
const CLASSIFIER_TIMEOUT_MS = Number.parseInt(
  process.env.TRENDING_SCOUT_CLASSIFIER_TIMEOUT_MS || "45000",
  10,
);
const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeCandidates(value) {
  if (!Array.isArray(value)) {
    throw new Error("candidates input must be a JSON array");
  }
  return value.map((candidate) => ({
    slug: String(candidate.slug || "").trim(),
    description: String(candidate.description || "").trim(),
    topics: Array.isArray(candidate.topics) ? candidate.topics.map(String) : [],
    star_delta: String(candidate.star_delta || "").trim(),
  })).filter((candidate) => candidate.slug);
}

function keywordScore(candidate) {
  const text = [
    candidate.slug,
    candidate.description,
    ...(candidate.topics || []),
  ].join(" ").toLowerCase();
  const rules = [
    ["ai agent", 7],
    ["agent", 5],
    ["agents", 5],
    ["mcp", 6],
    ["plugin", 4],
    ["plugins", 4],
    ["skill", 5],
    ["workflow", 4],
    ["automation", 4],
    ["llm", 4],
    ["openai", 4],
    ["claude", 4],
    ["knowledge", 3],
    ["markdown", 2],
    ["dev tool", 3],
    ["durable execution", 4],
    ["property management", 8],
    ["opencv", -4],
    ["textbook", -5],
    ["survival", -4],
    ["mobile number", -10],
    ["location", -5],
  ];
  const hits = [];
  let score = 0;
  for (const [term, weight] of rules) {
    if (text.includes(term)) {
      score += weight;
      hits.push(term);
    }
  }
  return {
    slug: candidate.slug,
    score,
    score_hits: hits,
    reason: hits.length ? `keyword hits: ${hits.join(", ")}` : "no in-lane keyword signal",
  };
}

function promptFor(candidates) {
  const compact = candidates.map((candidate, index) => ({
    id: index + 1,
    slug: candidate.slug,
    description: candidate.description,
    topics: candidate.topics,
    star_delta: candidate.star_delta,
  }));
  return `Classify these GitHub Trending repositories for AscendOps relevance.

Use only slug, description, topics, and star_delta. Do not infer from source code.

In-lane domains: agents, agent frameworks, AI orchestration, LLM tooling, MCP, workflow automation, dev tooling, property management.

Return ONLY valid JSON with this exact shape:
{
  "scores": [
    {"slug":"owner/repo","score":0,"score_hits":["short signal"],"reason":"one short reason"}
  ]
}

Rules:
- Include every input slug exactly once.
- score is an integer from -10 to 20.
- score >= 5 means relevance-pass.
- Keep reasons short and based only on provided metadata.

Candidates:
${JSON.stringify(compact, null, 2)}
`;
}

function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("classifier output did not contain JSON");
}

function runHaiku(candidates) {
  const result = spawnSync("claude", [
    "-p",
    "--model", MODEL,
    "--tools", "",
    "--no-session-persistence",
    "--max-budget-usd", MAX_BUDGET_USD,
    "--output-format", "text",
    promptFor(candidates),
  ], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: Number.isFinite(CLASSIFIER_TIMEOUT_MS) ? CLASSIFIER_TIMEOUT_MS : 45000,
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || result.signal || `exit ${result.status}`).trim();
    throw new Error(message);
  }

  const parsed = JSON.parse(extractJson(result.stdout));
  if (!Array.isArray(parsed.scores)) {
    throw new Error("classifier JSON missing scores[]");
  }
  const bySlug = new Map(parsed.scores.map((score) => [String(score.slug || "").trim(), score]));
  return candidates.map((candidate) => {
    const score = bySlug.get(candidate.slug);
    if (!score) {
      throw new Error(`classifier omitted ${candidate.slug}`);
    }
    return {
      slug: candidate.slug,
      score: Number.isFinite(Number(score.score)) ? Math.trunc(Number(score.score)) : 0,
      score_hits: Array.isArray(score.score_hits) ? score.score_hits.map(String).slice(0, 6) : [],
      reason: String(score.reason || "").trim(),
    };
  });
}

function isRecentlyStudied(seen, slug, now = Date.now()) {
  const entry = seen && seen[slug];
  if (!entry || !entry.last_studied_at) return false;
  const timestamp = Date.parse(entry.last_studied_at);
  return Number.isFinite(timestamp) && now - timestamp < RECENT_WINDOW_MS;
}

function shapeOutput(candidates, scores, seen, classification, classifierError) {
  const candidateBySlug = new Map(candidates.map((candidate) => [candidate.slug, candidate]));
  const scored = scores.map((score) => {
    const candidate = candidateBySlug.get(score.slug) || { slug: score.slug, description: "", topics: [], star_delta: "" };
    return {
      slug: candidate.slug,
      description: candidate.description,
      topics: candidate.topics,
      star_delta: candidate.star_delta,
      score: score.score,
      score_hits: score.score_hits || [],
      reason: score.reason || "",
      recently_studied: isRecentlyStudied(seen, candidate.slug),
    };
  }).sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  const passers = scored.filter((candidate) => candidate.score >= 5);
  const skippedRecently = passers.filter((candidate) => candidate.recently_studied);
  const eligible = passers.filter((candidate) => !candidate.recently_studied);
  const selected = eligible.slice(0, 3);
  const countedNotStudied = Math.max(0, eligible.length - selected.length);
  const skips = scored.filter((candidate) => candidate.score < 5);

  return {
    parsed: candidates.length,
    pass_count: passers.length,
    selected,
    counted_not_studied: countedNotStudied,
    passers,
    skipped_recently: skippedRecently,
    skips,
    classification,
    ...(classifierError ? { classifier_error: classifierError } : {}),
  };
}

function main() {
  const [candidatesPath, seenPath, outputPath] = process.argv.slice(2);
  if (!candidatesPath || !seenPath) {
    console.error(USAGE);
    process.exit(2);
  }

  const candidates = normalizeCandidates(readJson(candidatesPath, null));
  const seen = readJson(seenPath, {});
  let scores;
  let classification = `haiku:${MODEL}`;
  let classifierError = "";

  try {
    scores = runHaiku(candidates);
  } catch (error) {
    classifierError = error instanceof Error ? error.message : String(error);
    classification = "keyword fallback";
    scores = candidates.map(keywordScore);
  }

  const output = shapeOutput(candidates, scores, seen, classification, classifierError);
  const json = JSON.stringify(output, null, 2) + "\n";
  if (outputPath) {
    fs.writeFileSync(outputPath, json);
  } else {
    process.stdout.write(json);
  }
}

main();
