---
name: knowledge-base
description: "You are about to research a topic, answer a factual question about the org, or look up context about a person, project, or tool. Before searching the web or asking the user, query the knowledge base first — the answer may already exist from a previous research session. After you complete any substantial research, ingest your findings so future agents do not repeat the same work. The KB is the org's shared memory across all agents."
triggers: ["knowledge base", "kb", "search knowledge", "query knowledge", "ingest", "rag", "semantic search", "what do we know about", "check knowledge", "save to kb", "index documents", "search docs", "look up", "query kb", "kb query", "kb ingest", "store research", "preserve findings", "check existing knowledge", "has anyone researched", "kb setup", "initialize knowledge base"]
---

# Knowledge Base (RAG)

The knowledge base lets you search indexed documents using natural language — memory files, research notes, org knowledge. Query before searching externally. Ingest after completing research.

---

## Query (before starting research)

```bash
cortextos bus kb-query "your question" \
  --org $CTX_ORG \
  --agent $CTX_AGENT_NAME
```

Use this:
- Before starting any research task — check if knowledge already exists
- When referencing named entities (people, projects, tools) — check for existing context
- When answering factual questions about the org — query before searching externally

---

## Ingest (after completing research)

```bash
# Ingest to shared org collection (visible to all agents)
cortextos bus kb-ingest /path/to/docs \
  --org $CTX_ORG \
  --scope shared

# Ingest to your private collection (only visible to you)
cortextos bus kb-ingest /path/to/docs \
  --org $CTX_ORG \
  --agent $CTX_AGENT_NAME \
  --scope private
```

Ingest after:
- Completing substantive research (always ingest your findings)
- Writing or updating MEMORY.md
- Learning important facts about the org, users, or systems

---

## Shared-collection allowlist

`--scope shared` writes to the `shared-<org>` collection, which is gated by an ingest allowlist. A file lands only if its absolute path is on `shared_ingest_allowlist` in the KB config (`~/.cortextos/<instance>/orgs/<org>/knowledge-base/config.json`):

- A path matches if it **equals** an allowlist entry exactly, or sits **under** an allowlist directory (dir-prefix match).
- Anything not on the list is skipped with `BLOCKED (not in shared allowlist)` — the ingest does not error, it silently drops that file.
- `--scope private` (collection `agent-<name>`) is **exempt** — no allowlist, anything ingests.
- If `shared_ingest_allowlist` is unset or empty, shared ingest is open (legacy behaviour).

To add a source, append its absolute path (a file or a directory) to `shared_ingest_allowlist` in that config, then re-run the ingest.

Convention: shared-KB source docs live under `orgs/<org>/knowledge/` (already allowlisted), **not** `orgs/<org>/docs/`. Put any doc you intend to ingest into shared in `knowledge/`.

---

## List Collections

```bash
cortextos bus kb-collections --org $CTX_ORG
```

---

## Checking Available Collections

List all KB collections for the org:

```bash
cortextos bus kb-collections --org $CTX_ORG
```

If no collections appear, the KB may not be configured yet — check that `GEMINI_API_KEY` is set in `orgs/$CTX_ORG/secrets.env`.

---

## Workflow Pattern

```
1. User asks question about <topic>
2. kb-query "<topic>" — check existing knowledge
3. If found → answer from KB, cite source
4. If not found → research externally
5. After research → kb-ingest findings
6. Answer user with fresh knowledge now in KB
```
