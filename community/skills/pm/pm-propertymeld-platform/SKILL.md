---
name: pm-propertymeld-platform
effort: low
description: "Property Meld platform deep reference for <maintenance-agent>. Full feature coverage: Projects, make-ready/turnover lifecycle, workflow automation, three-way chat, vendor portal, integrations, KPIs, MAX On-Call, resident portal, scheduling."
triggers: ["property meld", "meld status", "how does meld work", "vendor portal", "three-way chat", "meld workflow", "what does pending mean", "meld lifecycle", "projects", "make ready", "turnover", "workflow automation"]
---
## Member Role Bindings

Before applying this skill, read the member organization configuration and bind
`<maintenance-owner>` to its escalation/approval owner and approved contact route,
`<maintenance-agent>` to its maintenance agent, and `<orchestrator-agent>` to its
coordinator. Use `CTX_ORCHESTRATOR_AGENT` for executable bus examples and
`CTX_AGENT_NAME` for the running agent's paths. Resolve vendor and in-house
technician placeholders from the same member configuration. If a required role
is missing or ambiguous, ask the configured coordinator before dispatch; never
substitute a person, agent or chat ID from an example. Existing emergency and
approval rules still govern actions.


# Property Meld Platform Reference — Full Feature Coverage

> Operational deep reference for <maintenance-agent>. Sources: Property Meld help center + product documentation.

---

## Complete Status Reference

### Open Statuses (someone needs to act)

| Status | Blocked on | Unblocked by |
|--------|-----------|-------------|
| **Pending Assignment** | PM/coordinator | Assign to vendor or internal tech |
| **Pending Vendor Acceptance** | Vendor | Vendor accepts or declines |
| **Pending Vendor Availability** | Vendor | Vendor proposes scheduling times |
| **Pending Resident Availability** | Resident | Resident selects from vendor's windows |
| **More Availability Requested** | Vendor (no auto-notify) | Vendor proactively updates; coordinator may need to prompt |
| **Pending Management Availability** | Internal tech | Tech selects schedule |
| **Pending Estimates** | Vendor (submit) or PM (approve) | Estimate submitted and approved |
| **In Progress / Pending Completion** | Vendor/tech | Work done, marked complete |

### Terminal Statuses (permanently read-only — cannot be reopened)

| Status | Meaning |
|--------|---------|
| Complete | Work finished successfully |
| Canceled / Manager Cancelled | PM cancelled (includes resident-requested cancellations processed by PM) |
| Resident Cancelled / Tenant Canceled | Resident cancelled via portal |
| Vendor Could Not Complete | Vendor unable to finish |
| Maintenance Could Not Complete | Internal tech unable to finish |

**Critical:** Terminal melds are permanently read-only. Closed in error = create a new meld.

---

## 1. PROJECTS

### What a Project Is

A container that groups multiple Melds under one umbrella with a shared timeline, progress tracker, and coordinator assignment. Used when a single outcome requires multiple trades — most commonly turnovers and make-readies. A Project gives the coordinator one view instead of hunting across individual Melds.

- **Standalone Meld** = one work order, one problem
- **Project** = many Melds, one outcome

### Where to Find Projects

Left nav → **Projects** tab. **Templates** tab within Projects holds reusable structures.

### How to Create a Project

**From template (recommended):**
1. Projects → Templates tab
2. Find template (e.g., "Standard Move Out" — Property Meld provides this out of the box)
3. Click "Create Project from this Template"
4. Fill in: property, start date, target due date, coordinator

**From scratch:**
1. Projects → Create Project
2. Add Melds two ways:
   - "Add Meld" — creates a new Meld inside the project
   - "Add Existing Meld" — attaches an already-created Meld

### Project Fields

- **Progress bar** — completed Melds / total Melds
- **Start Date / Due Date** — due date = target rent-ready date
- **Coordinators** — user(s) responsible

### Project Detail Page

Opens to the **Summary tab**:
- Overall progress
- Activity timeline
- Recommended actions if behind pace to hit target date
- **Spotlight section** — shows Melds requiring action with current status and tags; coordinator can act on them directly from Spotlight without navigating to each Meld

### What Belongs in a Project vs. a Standalone Meld

| Use a Project | Use a Standalone Meld |
|---|---|
| Turnover/make-ready (3+ trades) | Single repair (leaky faucet) |
| Work coordinated around a vacancy | Routine maintenance, one vendor |
| Multi-phase work with a target completion date | Emergency dispatch |
| Anything with sequenced trades across multiple days | Resident-submitted requests |

### Multi-Trade Sequencing

No formal dependency logic (Meld B cannot start until Meld A completes), but Spotlight and the progress bar give the coordinator visibility to manually sequence. Best practice: create Melds in trade execution order (clean → paint → flooring → lockset) and assign each as the prior trade completes.

### Turnover as a Project

Use the Standard Move Out template. Each trade = its own Meld with its own vendor, scheduling thread, and invoice. Coordinator monitors Spotlight daily. Project is complete when all Melds reach a closed status.

### What Good Project Management Looks Like

- Project created the day the move-out notice is received (not after keys are returned)
- Target date set at creation; Spotlight flags if pace is behind
- Each trade is its own Meld — not all crammed into one work order
- Vendors queued and pre-assigned so they start same day as move-out
- Coordinator checks Spotlight daily
- Invoices approved per Meld as each trade completes

### Common Project Mistakes

- Creating the project after keys are returned (vacancy time already burning)
- One work order for all make-ready trades (no per-trade visibility or accountability)
- No target date set (no Spotlight alerts, vacancy extends indefinitely)
- Coordinator only checks in when a vendor calls with a problem

---

## 2. MAKE-READY / TURNOVER WORKFLOW — FULL LIFECYCLE

### Industry Benchmarks

- Target: **7–10 days** from move-out to rent-ready
- 45% of PM companies complete in 9 days or less; 33% take 13+ days
- Average cost per turnover: **$1,750–$2,500** (excluding vacancy loss)
- A 14-day turnover on a $1,600/month unit costs ~**$3,009** with vacancy loss factored in
- 80% of turnovers occur May–September — plan vendor capacity accordingly

### The 11-Step Lifecycle

**Step 1: Move-Out Notice Received**
- Create a Project from the Standard Move Out template immediately
- Set target rent-ready date; assign coordinator
- Do not wait until after keys are returned

**Step 2: Pre-Move-Out Inspection**
- Create an inspection Meld inside the project
- Assign to internal tech or inspection vendor (zInspector integrates directly)
- Goal: identify scope of work before move-out so vendors can be lined up in advance

**Step 3: Property Marketing**
- Handled in PMS/leasing system, not Property Meld
- Best practice: list with existing photos while still occupied; new photos come after make-ready

**Step 4: Scope Build-Out (after inspection)**
Create individual Melds inside the project:
- Deep cleaning → cleaning vendor
- Paint / wall repairs → painter
- Flooring replacement or cleaning → flooring vendor
- Appliance repairs → appliance tech
- HVAC filter/tune-up → HVAC vendor
- Plumbing check → plumber
- Lockset change → locksmith or internal tech (always last)

**Step 5: Key and Final Payment Collection**
- Handled in PMS
- In Property Meld: update any Melds requiring resident presence to "no presence required" — unit is now vacant

**Step 6: Move-Out Inspection (Final)**
- Confirm no personal items remain, document condition with photos/video
- This Meld's documentation = basis for security deposit accounting

**Step 7: Vendor Coordination and Execution**
- Each vendor receives their Meld; accepts; schedules
- No resident presence required = faster scheduling (vendor picks their window)
- Coordinator monitors Spotlight for bottlenecks; approves invoices as each trade completes

**Step 8: Lock Change**
- Final Meld before showing — must be confirmed complete before property is shown
- Create as the last Meld in the project sequence

**Step 9: Showings**
- Handled in leasing system
- Rent-ready flag: Project at 100% or coordinator manually signals completion

**Step 10: Tenant Screening → Lease Execution**
- Handled in PMS

**Step 11: Move-In Inspection**
- New standalone Meld or second project phase
- Document with photos; establishes baseline for new tenancy

---

## 3. WORKFLOW AUTOMATION

### What Workflows Are

Rule-based automations: trigger + optional conditions + actions. Coordinator intervention not required. Access: left nav → **Workflows**. Admin and Agent roles only.

### Trigger Types

**Time Events** — fire based on elapsed time relative to a Meld state (e.g., "X days after Meld created with no assignment")

**Change Events** — fire when a user or system generates an activity record:
- Meld created
- Meld status changes (any status transition)
- Meld assigned to vendor
- Vendor accepts / declines
- Work marked complete
- Invoice submitted / approved
- Estimate submitted / approved / rejected
- Comment created (any chat message)

### Conditions (filter when the workflow fires)

- Property, unit, or property group
- Issue category / trade type
- Assigned vendor or technician
- Meld tags
- Date thresholds (before/after date)

Combine multiple conditions with AND / OR logic.

### Actions

- **Send a chat message** using a saved Chat Template (recipient visibility set on the template)
- **Delay** — pauses execution before next action (enables multi-step sequences)
- Additional action types exist in-app (Property Meld's UI offers more than public docs enumerate)

### Recommended Automations (Property Meld best practices)

| Automation | Trigger | Action |
|---|---|---|
| **Resident acknowledgment** | Meld created | Send receipt confirmation; set expectations for business hours |
| **HVAC troubleshooting** | Meld created with "HVAC" in description | Send resident troubleshooting template (check filter, thermostat, breaker) |
| **Garbage disposal / drain self-fix** | Same pattern | Send self-service resolution steps |
| **Vendor introduction** | Meld assigned to vendor | Message resident with vendor name so they recognize the unknown number |
| **Invoice request** | Meld marked complete → 24h delay | Send vendor chat message requesting invoice |
| **Completion confirmation** | Meld marked complete | Ask resident to confirm work done before billing is processed |
| **Post-repair survey** | Meld closes | Send satisfaction rating request |
| **Stale meld nudge** | Pending Assignment for X days | Alert coordinator to take action |
| **Estimate request** | Meld created in specific category | Send vendor a message requesting estimate before scheduling |

### Chat Templates and Workflows

Workflows that send messages use saved Chat Templates. Templates must have **visibility set correctly** — wrong visibility sends the message to the wrong party. Templates support placeholders in `__double_underscore__` format for quick personalization. Manage templates: Company Settings → Chat Templates.

### Configuration

Workflows → Create Workflow (from scratch) or Create With Template (from preset Templates tab).

---

## 4. THREE-WAY CHAT

### Architecture

Every Meld has a Chat tab — a threaded communication log that persists for the life of the Meld and becomes part of its permanent record. All communication should happen inside the Meld. Off-platform communication (phone/text) creates undocumented history and prevents other coordinators from seeing what happened.

### Recipient Groups

Select recipient **before** typing. "Will be seen by" label confirms who receives the message.

| Recipient Group | Who sees it | When to use |
|---|---|---|
| Managers, Vendors, and Residents | All parties | General updates, scheduling confirmations, completion notices |
| Managers and Vendors | Staff and vendor only | Vendor coordination, cost discussions, internal notes that residents don't need |
| Managers and Owners | Staff and owner | Approval requests, cost discussions |
| Managers only | Internal staff | Internal notes — residents and vendors cannot see |

**Vendor behavior:** Vendors can send to Managers + Residents + Vendors, or Managers + Vendors only. Vendors cannot message residents alone (all comms go through the manager channel).

**Owner behavior:** Owners access chat via Owner Hub; they see Manager/Owner channel messages.

### Delivery Status

Below each sent message, click to see: **Read**, **Not Read**, **No Delivery Failures**, or **Delivery Failed** (check contact info).

### AI Tools

**AI Translate (8 languages):** Click translate below any message. Residents and vendors can reply in their native language. Enables bilingual coordination without bilingual staff. Available to all standard plan customers.

**AI Message Assist:** In the compose area. Type rough intent; AI generates a polished professional message. Useful for difficult situations where tone matters (damage charges, non-renewals, vendor performance issues).

**AI Summary:** Condenses a full thread to bullet points. Use when an owner or supervisor asks "what's going on?" without reading 40 messages.

### Common Mistakes

- Sending vendor cost discussions to residents (use Managers and Vendors only)
- Communicating off-platform via phone or text (creates undocumented history)
- Not verifying "Will be seen by" before sending
- Letting chat threads grow without using AI Summary for stakeholder updates

---

## 5. VENDOR PORTAL — FULL VENDOR EXPERIENCE

### How Vendors Get Access

Invitation from the PM company (no self-serve signup). PM adds vendor → invitation generated. Alternatively, vendors apply through **Vendor Nexus** (5-stage vetting: application, reputation check, compliance, platform training, interview). Nexus covers 81% of the U.S.

### What Vendors See

Four navigation sections:
- **Incoming Requests** — new Melds awaiting acceptance
- **Melds** — all active and historical Melds
- **Invoices** — all invoices in progress or submitted
- **Estimates** — estimate requests from PMs

### Accepting a Meld

1. Incoming Requests → click Accept → confirmation → Accept again
2. If resident presence required: vendor sees resident's 5+ availability windows; selects one — OR sends their own windows for resident to choose from
3. If no resident presence required: vendor selects their own window
4. Status moves to In Progress / Pending Completion

**Reassignment rules:**
- Reassigned from one vendor to another: appointment is canceled; new vendor schedules from scratch
- Reassigned from one internal tech to another: appointment transfers intact

### Estimate Flow

Meld title shows "(Estimate)" prefix. Vendor accepts → if no site visit needed, clicks "NOT NOW" on scheduling page → submits estimate with cost breakdown → PM approves or rejects → if approved, work proceeds.

### Invoice Submission

After marking Meld complete, vendor submits invoice:

**Option A — Line items:** Description, Quantity, Price per line. Optional Notes. Submit → confirm.

**Option B — File upload:** Upload invoice file + enter total amount. Submit.

Vendor can edit invoice until PM approves. Once approved, it locks. Payment handled outside Property Meld (PM processes payment externally).

**Invoice statuses:** Draft → Submitted → Approved → Paid

**Integration sync:**
- AppFolio: Approved invoices → AppFolio Bills (vendor must be manually linked)
- Buildium: Approved invoices → Buildium Bills (same manual linking required; $0 line items do not sync)
- Yardi: Approved invoices → Yardi payables

### What Vendors Can Do

Accept/decline Melds | Schedule appointments | Communicate via Meld chat | Submit invoices and estimates | View their full Meld and invoice history

### What Vendors Cannot Do

Modify Meld details | Create accounts without invitation or Nexus approval | Message residents independently (all comms through manager channel) | Close or cancel a Meld (can only mark "could not complete") | Access other vendors' Melds

### Setting Expectations with Vendors

- All scheduling through Property Meld — not via coordinator phone/text
- Submit invoices within 24–48 hours of completion (automate a prompt via Workflow)
- Use Meld chat for all communication
- Upload completion photos to the Meld
- If unable to complete: mark "Vendor Could Not Complete" — do not abandon the Meld

---

## 6. ACCOUNTING INTEGRATIONS

### AppFolio ↔ Property Meld

**AppFolio → Property Meld (every ~2 hours):** Properties, units, residents/homeowners, owners, maintenance notes

**Property Meld → AppFolio (real-time on trigger):** Meld info → AppFolio Work Orders; Approved invoices → AppFolio Bills (requires manual vendor linking); Billable Items → AppFolio work order

**What does NOT sync:** Updating a property in Property Meld does not update AppFolio. Updating a work order in AppFolio does not update the Meld. Vendor matching is always manual.

**Setup:** AppFolio Stack marketplace.

---

### Buildium ↔ Property Meld

**Buildium → Property Meld (every ~4 hours):** Properties, units, tenants, owners

**Property Meld → Buildium (on invoice approval):** Approved invoices → Buildium Bills (manual vendor linking required)

**What does NOT sync:** Melds/work orders do not sync to Buildium (only invoices). HOAs do not sync. $0 line items do not sync. Owners not auto-invited on import.

---

### Yardi ↔ Property Meld

**Yardi → Property Meld:** Portfolio data, contacts, residents (auto-invited after move-in)

**Property Meld → Yardi:** Approved invoices → Yardi payables. Supported: Voyager 7, 7S, 8 only.

**Setup:** Requires API URL, Server Name, and Interface User credentials from Yardi System Administration.

---

### Other Partners

Rent Manager | Propertyware | Rentvine | zInspector (inspection integration — feeds into make-ready projects)

All integrations included at no extra charge.

---

## 7. REPORTING AND KPIs

### Platform Tools

**Insights** (Core plan): Real-time dashboard — communication, scheduling, staffing, profitability metrics.

**Insights Pro** (Ops plan, $2/door): Adds competitive benchmarking, technician/vendor/coordinator performance analysis, financial tracking.

**Monthly Benchmark Report:** Property Meld publishes monthly using 10M+ work orders. Covers repair speed, resident satisfaction, costs, seasonal patterns by category.

### Key KPIs and Benchmarks

| KPI | Benchmark / Target |
|-----|--------------------|
| Speed of Repair (submission → completion) | World-class: 2.7 days; Good: 3.4–3.5 days |
| HVAC cycle time | ≤ 3.5 days |
| Plumbing cycle time | ≤ 4.5 days |
| Electrical cycle time | ≤ 5 days |
| **Critical threshold** | **> 5.5 days = near-zero chance of positive review** |
| Speed to assign | Same day (0 days with automation) |
| Speed to schedule | Hours, not days; target < 4 minutes with automation |
| Technician utilization | ≥ 75% (service hours / payroll hours) |
| Jobs per day | Track balance vs. quality |
| Photo attachment rate | Target 80–90% of submissions |
| Resident satisfaction | Target 4.2–4.6 / 5; 3/5 is damaging |
| Resident retention | 46% of move-outs cite maintenance; 31% say it was primary reason |
| Cost per work order | Track by category; use for owner reporting |

### <maintenance-agent>'s Age-Based Escalation Rules (derived from KPI benchmarks)

| Meld age | Flag | Action |
|----------|------|--------|
| ≥ 4 days | Approaching critical | Include in morning scan report; message the configured orchestrator if no vendor assigned |
| ≥ 5.5 days | Critical threshold | Message the configured orchestrator immediately, any time of day |

---

## 8. MAX ON-CALL

### What It Is

AI-powered phone answering for after-hours maintenance intake. Resident calls a designated number; MAX handles the call via conversational AI, creates the Meld, and routes based on urgency — no live dispatcher needed.

### How It Works

1. Resident calls after-hours number
2. MAX engages immediately (no hold, no voicemail)
3. MAX asks follow-up questions in natural language
4. MAX prompts for photos/video via SMS follow-up
5. MAX assesses severity against the PM's **custom emergency definition**
6. **Emergency:** activates after-hours call tree; contacts on-call staff sequentially until claimed
7. **Non-emergency:** documents issue, creates Meld, routes to next-business-day queue

### What MAX Handles

New request submission | Status check on existing Meld | Rescheduling | Cancellation | After-hours emergencies (heating, flooding, lockouts, HVAC)

### Key Stat

40% of issues self-reported as emergencies by residents are triaged down to non-emergency by MAX. Reduces unnecessary after-hours dispatches 30–50%.

### Configuration

- Define emergency threshold (what counts as an emergency for your portfolio)
- Set after-hours call tree (who, in what order, what happens if no answer)
- Configure per-property applicability
- Set SMS follow-up preferences

---

## 9. RESIDENT PORTAL

### Access

Web-based; no app download. 90% reported adoption rate. Credentials persist after initial setup.

### Submitting a Request

1. Resident clicks New Meld
2. Describes issue; uploads photos/videos
3. If MAX Intelligence enabled: conversational diagnostic; may resolve without dispatch
4. Prompted to select **5 or more availability windows** (if presence required)
5. Confirmation message sent immediately upon submission

### Scheduling Interaction

- Resident selects from vendor's proposed windows
- If no overlap: clicks "Request More Availability" — **vendor does NOT receive a notification**; coordinator must prompt the vendor manually
- Resident can update their own availability windows

### Post-Completion

- Notification to provide star rating and feedback when Meld closes
- Feeds directly into PM's Resident Satisfaction metric in Insights

---

## 10. MAINTENANCE SCHEDULING

### The Model

Resident and vendor availability are given equal weight. The system facilitates a self-service availability negotiation. Coordinator intervenes only when parties cannot agree.

### Full Scheduling Flow

1. **Pending Assignment** → PM assigns to vendor or tech
2. **Pending Vendor Acceptance** → vendor accepts
3. **Availability exchange:**
   - If resident presence required: vendor selects from resident's windows (or sends their own windows back)
   - If no presence required: vendor selects their own window without resident involvement
4. **In Progress / Pending Completion** → appointment confirmed
5. **Complete** → vendor marks done → invoice opens → resident feedback triggered

### Scheduler IQ (Ops Plan)

Smart assignment feature. Recommends vendor/tech based on proximity, past reviews, cost efficiency, and availability. Automates the assignment decision coordinators otherwise make manually.

### Reassignment

- New vendor: appointment canceled; new vendor schedules from scratch
- New internal tech: appointment transfers intact

---

## USER ROLES

| Role | Key access |
|------|-----------|
| Admin | Full; configures Workflows, Chat Templates, integrations |
| Agent | Full operational; can manage Workflows |
| Maintenance Coordinator | Assign, schedule, communicate, manage Melds and Projects |
| Vendor | Accept/decline, schedule, chat, invoices, estimates |
| Resident | Submit, availability, chat, feedback |
| Owner | Owner Hub: view Melds, approve spend, chat, set notifications |

**Owner Approval Dollar Amount:** PM sets a threshold; invoices above it require owner approval before payment. Approval requests go through the platform.

---

## PRICING

| Plan | Price | Adds |
|------|-------|------|
| Core | $1.60/door/month | Work order tracking, chat, MAX Intelligence, integrations |
| Ops | $2.00/door/month | Scheduler IQ, Insights Pro, Vendor Nexus, financial tracking |
| Enterprise | Custom | 50,000+ units |

Minimum: $160/month. No extra charge for integrations.

---

*Sources: Property Meld help center (support.propertymeld.com), propertymeld.com/blog, and product documentation. Distilled 2026-04-14.*
