---
name: pm-inspections
effort: low
description: "Property Meld inspection workflows — integration partners (zInspector, Inspectify, Seek Now), inspection types, scheduling, templates, completion workflow, move-in/move-out comparison, resident and owner visibility, and connection to turnover Melds. No native PM inspection module — all inspection tools are third-party via the Nexus program."
triggers: ["inspection", "move-in inspection", "move-out inspection", "zInspector", "inspect", "condition report", "tenant sign-off", "property walkthrough", "inspection template", "inspection findings", "meld from inspection"]
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


# Property Meld Inspections — Full Reference

> Property Meld has **no native inspection module**. Inspections run through third-party partners in the Nexus program. Findings push into Property Meld as Melds (work orders).

---

## 1. INSPECTION PARTNERS (Nexus Program)

Three partners are available through the Property Meld Nexus ecosystem:

### zInspector (March 2025 — Primary Integration)
The deepest technical integration. **Two-way connected workflow** — inspection findings automatically generate Melds in Property Meld. DIY model: property management staff conducts inspections using the zInspector 3 mobile app. Tenants can complete their own move-in inspections via the separate zTenant app.

Best for: AscendOps standard move-in, move-out, and routine inspections.

### Inspectify (February 2025)
Platform with a network of professional inspectors. PM dispatches a professional via the Property Meld interface. Data-driven inspection reports connect to maintenance operations. Not a DIY tool — you pay for a professional inspector.

Best for: Due diligence on acquisitions, condition assessments when you need a third party.

### Seek Now (April 2025)
Uses LiDAR-powered walkthroughs, asset tagging, damage tagging, precise floorplans. Handles 2,000+ inspections daily across 200+ cities. Targets institutional portfolios; overkill for AscendOps use case.

**For AscendOps operations, default to zInspector.**

---

## 2. INSPECTION TYPES SUPPORTED (zInspector)

| Type | Who Performs | App Used | Notes |
|------|-------------|----------|-------|
| **Move In** | Staff/inspector | zInspector 3 | Staff-conducted move-in condition documentation |
| **Move Out** | Staff/inspector | zInspector 3 | Pre-populates from prior Move In data for comparison |
| **Inspection** | Staff/inspector | zInspector 3 | All others: Pet, Violation, Annual, Smoke Detector, Routine |
| **Pre-Inspection** | Staff/inspector | zInspector 3 | Preliminary walkthrough (e.g., Pre-Move Out notice) |
| **Tenant Move In** | Tenant | zTenant app | Tenant-completed; does NOT appear in staff app |
| **Tenant Inspection** | Tenant | zTenant app | Annual, renewal, or periodic tenant-completed inspections |

**Standard templates available:** Move In, Move Out, Periodic, Renewal, Due Diligence.

---

## 3. SCHEDULING WORKFLOW

Property Meld has no dedicated inspection scheduling module. Two paths:

**Path A — Via zInspector (primary):**
Scheduling happens inside zInspector, not in Property Meld. Staff opens the app, selects the property/unit, chooses the inspection type, and conducts the inspection. Findings push into Property Meld after completion.

**Path B — Via PM Workflow Automation (trigger):**
Use Property Meld's Workflow feature to create a Meld as a prompt/reminder:
- Time event: "Create a 'Schedule routine inspection' Meld every 6 months"
- Change event: "When a resident submits notice, create a 'Schedule move-out inspection' Meld"

This Meld then prompts the coordinator to conduct the actual inspection through zInspector.

**Roadmap (not yet live):** Property Meld announced that completed inspections will eventually trigger automatic work distribution through PM's scheduling engine based on technician/vendor availability.

---

## 4. INSPECTION TEMPLATES (zInspector)

Templates are built on the **zInspector web platform** (not the mobile app). Structure:

- **Areas** — rooms and zones (Kitchen, Master Bedroom, HVAC Room, etc.)
- **Details/Items** — individual items within each area (Sink, Countertop, Refrigerator, etc.)
- **Fields per item** — condition rating, comments, photos

### Condition Rating Scale

| Code | Meaning | Notes |
|------|---------|-------|
| **N** | New | Extended: **E** = Excellent |
| **S** | Satisfactory | Extended: **F** = Fair, **P** = Poor |
| **D** | Damaged | Extended: **DN** = Damaged & Needs Attention, **DR** = Damaged & Needs Re-Hab |

Items marked **Damaged** automatically populate the security deposit return calculation spreadsheet.

### Custom Template Fields Available
- System auto-fill: Current Date, Property Name, Tenant Name, Inspector Name, Reference Number
- Contact database: Current Tenant, Vendor, Owner, Inspector (with email/phone)
- Text, paragraph, date, numeric, dropdown, checkbox/boolean fields
- Signature boxes (required or optional) — for inspector and/or tenant
- Initials fields

### Access Control by Type
- Types labeled "Tenant Move In" or "Tenant Inspection" → appear only in the **zTenant app** (resident-facing)
- All other types → appear only in the **zInspector 3** staff/inspector app

> Note: Template customization is labeled "recommended for experienced zInspector users." Standard templates meet most use cases out of the box.

---

## 5. COMPLETION WORKFLOW (zInspector)

### During the Inspection (Mobile App — zInspector 3)
1. Select property/unit → choose inspection type → enter tenant name and inspector name
2. Work through each area — every area must be completed or explicitly marked skipped
3. Per item: assign condition rating (N/S/D), add photos with optional markup annotations, add notes
4. Items requiring documentation flag red until complete; turn green when done
5. 360-degree photos and video supported alongside standard photos
6. All photos are auto-timestamped and geotagged

### Completion and Signatures
- Inspector signature field at conclusion (required)
- Tenant signature field (optional) — tenant can sign on the inspector's device at time of inspection
- Once all areas are green, report is previewed and submitted

### After Submission
1. Report automatically sent to zInspector website (accessible via web dashboard)
2. Copies emailed to configured recipients (owner, tenant, vendor — set in Profile Settings)
3. Report appears in the **Timeline** — the chronological property history log
4. Damaged items auto-populate the security deposit return calculation spreadsheet
5. **If Property Meld integration is active:** repair/action items automatically convert into Melds in Property Meld and route for vendor/tech assignment

### Report Format
PDF export, shareable via email directly from the mobile app or website. Photos embedded inline.

---

## 6. ZINSPECTOR + PROPERTY MELD INTEGRATION

**Live functionality (as of March 2025 launch):**

One-direction push: zInspector → Property Meld.

1. Inspector completes inspection in zInspector 3 (or tenant in zTenant)
2. Repair/action items identified and categorized in zInspector
3. Those items **automatically convert into Melds (work orders) in Property Meld**
4. Melds are immediately available for assignment to vendors/techs

The integration eliminates manual re-entry — inspection findings land directly in Property Meld's maintenance queue.

**Enrollment:** Requires being a customer of both Property Meld and zInspector.

**Roadmap (announced, not yet live):**
- Auto-Turnover Project creation: when a move-out inspection completes, a Turnover Project auto-generates in Property Meld, pre-segmented by category/work type
- Smarter resource allocation: PM scheduling optimizes Meld assignment based on availability
- Cost and revenue insights: links repair costs to turnover financial data

---

## 7. TENANT-COMPLETED MOVE-IN INSPECTIONS

<maintenance-agent> should know this workflow — it shifts documentation burden to the tenant and creates a legally signed baseline.

### How to Invite Tenant
1. In zInspector web, go to Tenants page
2. Click "Invite" in the Tenant Move In column for the tenant
3. Customize the welcome email if desired
4. Tenant receives invitation → downloads zTenant app (rated 4.9 stars) → logs in

### Tenant's Experience
- Preset template for their unit (they see the standard Move In template)
- Marks each detail: condition rating (S = Satisfactory or D = Damaged), photos, comments
- Red flags indicate required documentation
- Tenant submits → copy auto-emailed to both tenant and property manager

### Invitation Status Tracking
Invite → Invited → Scheduled → Submitted → Expiring/Expired (grace period available)

### Outcome
- Report appears in the Timeline
- Tenant has a signed, documented move-in baseline on file
- Damaged items they note are on record — protects PM at move-out

---

## 8. RESIDENT AND OWNER VISIBILITY

### Resident
- **At inspection time:** Tenant can sign on the inspector's device (in-person staff inspection)
- **Tenant-completed inspections:** zTenant app, fully self-service
- **Post-inspection report sharing:** "Share with tenants" button in zInspector makes report visible in Tenant Portal
- **Auto-email:** Residents can be configured as email recipients at inspection completion
- **Meld interaction:** After zInspector creates Melds from findings, residents receive standard PM notifications and can communicate in the Meld thread. Post-repair review request fires automatically when Melds close.

### Owner
- **Report sharing:** "Share with owners" button in zInspector makes inspection report visible in Owner Hub
- **Email:** Owners can be added as email recipients at inspection conclusion (from mobile app)
- **Meld visibility:** If the property manager enables owner notifications on Melds created from inspection findings, owners see them in real time through PM's Owner Hub
- **Approval threshold:** Invoices above the PM-set dollar threshold require owner approval before payment

---

## 9. MOVE-OUT INSPECTION + TURNOVER WORKFLOW

This is the highest-value inspection workflow for AscendOps.

### Move-Out Inspection in zInspector
1. Open zInspector 3 → select property/unit → choose Move Out template
2. System **pre-populates the template with the tenant's move-in notations** (conditions, comments, photos from the prior Move In inspection) — so the inspector can see what was there at move-in inline while walking the unit
3. Inspector works room by room, noting changes
4. Damaged items auto-populate the **security deposit return calculation spreadsheet**

### Move-In / Move-Out Comparison Report
- Generated on the **zInspector website** (not the mobile app)
- Go to Timeline → click "Compare Documents" (scale icon) → select the two inspections → click Compare
- Output: **side-by-side PDF** showing conditions and photos from both inspections, making changes visually apparent
- This is the industry standard for deposit dispute documentation (used by California Association of Realtors)
- Share or email directly from the website

### Connection to Property Meld Turnover
After the move-out inspection, repair items push to Property Meld as individual Melds. Those Melds form the make-ready/turnover work. Assign to vendors and monitor via Project Spotlight.

> **Roadmap:** Automatic Turnover Project creation (segmented by category) upon inspection completion is announced but not yet live. Currently, Melds are created individually.

---

## 10. BEST PRACTICES (Property Meld's Recommendations)

**Inspection cadence:**
- Move-in: immediately at lease start
- Routine: bi-annual minimum; quarterly improves early issue detection
- Move-out: as close to actual vacancy date as possible

**Tenant-completed move-in:**
Invite the tenant to complete their own move-in inspection via zTenant app. This shifts documentation burden to the tenant and creates a signed, self-reported baseline — strongest protection at move-out dispute.

**Make-ready start:**
Begin the make-ready project the moment a resident submits notice. Conduct the pre-move-out inspection before keys are returned to line up vendors in advance.

**Deposit documentation:**
Use the side-by-side comparison report. Timestamped photographic evidence with before/after conditions is the standard for deposit dispute resolution.

**Owner communication:**
Keep owners notified on Melds with costs, particularly during turnovers. PM's research ties maintenance transparency directly to owner retention.

**Preventive maintenance driver:**
Use routine inspections to create proactive Melds (aging equipment, upcoming maintenance needs) before issues become emergencies.

---

## 11. WHAT PM DOES VS. INTEGRATION

| Function | Native in Property Meld | Via zInspector |
|----------|------------------------|----------------|
| Inspection scheduling | Via Workflow Automation (time/change triggers) | In-app scheduling |
| Conducting inspections | No | zInspector 3 (staff), zTenant (tenant) |
| Inspection templates | No | Yes — standard + custom |
| Condition ratings (N/S/D) | No | Yes |
| Photos during inspection | No | Yes — geotagged, timestamped |
| Resident sign-off | No | Yes — on-device signature |
| Tenant-completed inspections | No | Yes — zTenant app |
| Move-in/move-out comparison | No | Yes — side-by-side PDF |
| Security deposit spreadsheet | No | Auto-populated from damaged items |
| Creating Melds from findings | Yes — via integration | zInspector pushes → PM creates |
| Turnover project from inspection | Roadmap (not yet live) | — |
| Owner portal for reports | Via PM Owner Hub (if notified) | Share-with-owners button |

---

*Sources: Property Meld blog (propertymeld.com/blog), Nexus program pages, zInspector help center (support.zinspector.com), zinspector.com features documentation. Distilled 2026-04-15.*
