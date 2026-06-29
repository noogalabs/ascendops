---
name: make-ready-scheduling
description: "Build the schedule to turn a vacant unit rent-ready by a target date: order trades by dependency, set a window per task, find the critical path, and flag slip risk. Plans only, actual vendor dispatch goes through vendor-coordination."
---

# Make-Ready Scheduling

{{agent_name}} uses this skill to plan a turn as the small project it is. A turn has real dependencies: order the trades wrong or stack them on one day and the target date slips while the unit sits empty. This builds the plan so the work flows and the risk is visible early. It books nothing itself.

---

## Hard Gate

This skill plans only. It does not dispatch vendors, message anyone, or commit spend. The ordered task list and windows are handed to vendor-coordination, where each dispatch is approval-gated.

---

## Inputs

- Target ready date
- Scope of work (from a move-out inspection or scope source)
- Available start date
- Known durations and constraints per task
- Dry/cure times that must be their own calendar blocks
- Known lead times, vendor confirmation status, and single-trade-no-backup risks

---

## Workflow

1. Take the scope and break it into tasks: trash-out, demo, repairs, paint, flooring, fixtures, deep clean, final inspection.
2. Order the tasks by dependency, what must finish before the next can start, respecting dry and cure times as their own blocks.
3. Assign a window to each task from the available start date and known durations.
4. Find the critical path (the longest dependent chain), which sets the soonest possible ready date.
5. Compare the finish to the target: on track with slack, or at risk with the gap and the driving tasks named.
6. Flag slippage risk beyond the math: long lead times, an unconfirmed vendor, or a single trade with no backup.
7. Hand the ordered task list and windows to vendor-coordination for dispatch. Book nothing here.

---

## Output Contract

Produce a make-ready plan with:
- ordered task list with dependencies
- a window per task (including dry/cure blocks)
- the critical path and the soonest possible ready date
- on-track-with-slack or at-risk-with-gap verdict against the target date
- driving tasks and named slip risks
- the task list handed off to vendor-coordination

---

## Validation

- Tasks are in valid dependency order; dry/cure times are their own blocks.
- The critical path is identified and drives the ready date.
- Target vs finish is stated explicitly (slack or gap).
- No vendor was dispatched and nothing was booked here.
