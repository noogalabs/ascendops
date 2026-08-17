# HTML Briefing — Canonical Template

**Locked fleet-wide 2026-05-25 by David direct.**

All long human-facing HTML artifacts (morning briefs, status updates, decision docs, multi-section reports, design proposals, anything sent as a Telegram document attachment for David) MUST use the canonical dark-mode template at `template.html` in this directory. NEVER hand-roll a different design.

## Why

David direct pushback 2026-05-25 ~8:25am EDT after an agent hand-rolled a white-styled HTML morning brief instead of using the locked dark-mode template. Quote: *"what happened to the design you had made? We were going to use that. It was the previous HTMLs. It was nice, dark, crisp, clean colors. I really like the layout. You had it going. Now we're back to this white, choppy, nasty looking shit. Let's get this shit locked in."*

Then immediately after: *"thank you van you make sure all agents use this moving forward"* — confirms fleet-wide application.

This sits ON TOP of the existing **html-for-human-artifacts** rule (long artifacts ship as HTML, not markdown). That rule says "use HTML"; this rule says "use THIS HTML design".

## How to apply

1. Copy `template.html` from this directory verbatim (the entire `<style>` block + body skeleton)
2. Fill in body content for your specific artifact (gates, agent-health rows, focus banner, cards, lists, etc.)
3. Send as document attachment via Telegram: `cortextos bus send-telegram --file /tmp/your_artifact.html $CTX_TELEGRAM_CHAT_ID "<short caption>"`
4. Do NOT invent new colors, new layout primitives, or "improvements" — the design is locked

## Design tokens (DO NOT CHANGE)

| Token | Value | Use |
|---|---|---|
| Background | `#0f1419` | body bg, deep slate |
| Text | `#e6e6e6` | primary text, warm white |
| Muted | `#8b949e` | H2, subtitles, meta |
| Card bg | `#1a1f2e` | content panels |
| Card border | `#2d3748` | borders, dividers |
| Code bg | `#131825` | inline code, stats |
| Code text | `#f8c891` | inline code text |
| Signal accent | `#fbbf24` | highlighted info |
| Focus accent | `#58a6ff` | banner left border, H3 |
| Green badge | `#1e4d2b` bg / `#4ade80` text | healthy / done |
| Yellow badge | `#3a2d1a` bg / `#fbbf24` text | warning / pending |
| Red badge | `#4d1e1e` bg / `#f87171` text | broken / blocked |
| Blue badge | `#1e3a4d` bg / `#60a5fa` text | informational |
| Gray badge | `#2d3748` bg / `#94a3b8` text | quiet / dormant |

## Section primitives (mix and match)

- `<div class="focus-banner">` — gradient header for primary focus / TL;DR
- `<div class="card">` — content panel with rounded border
- `<div class="card tight">` — same but reduced padding for dense lists
- `<div class="row">` with `.label` + `.body` — labeled rows in a card
- `.stat-grid` + `.stat` + `.stat-num` + `.stat-label` — numeric tiles
- `.gate` + `.gate.done` / `.gate.pending` — gate-progress rendering
- `.badge.green/yellow/red/blue/gray` — colored chip indicators
- `<ul class="tight">` — compact bulleted list

## Examples in canonical style

- `$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/an agent/telegram-images/subagent-prompt-structure-2026-05-24.html`
- `$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/an agent/telegram-images/sms-mms-plan-2026-05-24.html`
- `$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/an agent/telegram-images/programmatic-mcp-plan-2026-05-24.html`

## Drift signal

If you find yourself writing `body { ... background: #ffffff` or any light-mode styling for a Telegram-attached HTML artifact — STOP, switch to the canonical dark palette. If the template doesn't have a primitive you need, ADD ONE that matches the existing palette; do NOT invent off-palette colors.
