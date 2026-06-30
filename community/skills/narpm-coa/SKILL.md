---
name: narpm-coa
effort: medium
description: "Map a property manager's CURRENT chart of accounts onto the NARPM® Trust Chart of Accounts standard, and produce their migration plan: which existing accounts to rename and renumber, which new accounts to add, which to consolidate, and which to archive. Use when an operator wants to adopt (or audit against) the NARPM Trust COA, when onboarding a new accounting client whose books are non-standard, or when their GL is a tangle of overlapping fee and expense accounts. Pure know-how: the agent reads the operator's GL export and writes their mapping; no scripts required."
triggers: ["narpm coa", "narpm chart of accounts", "narpm trust coa", "chart of accounts", "coa migration", "gl account mapping", "standardize chart of accounts", "trust accounting coa", "renumber gl accounts", "appfolio gl accounts", "account mapping", "map my chart of accounts", "trust coa standard"]
---

# NARPM® Trust Chart of Accounts mapping

This skill takes an operator's **current** general-ledger accounts and maps them onto the **NARPM® Trust Chart of Accounts** standard, then produces a migration plan they can execute in their property-management accounting system. The output is a per-account table: keep-and-renumber, add-new, consolidate, or archive, with the action marked on every line.

You bring the standard and the method; the operator brings their GL export. You do the mapping.

> **What this is, and what it is not.** This is a standardized chart of accounts and a migration methodology, reproduced here so an operator can adopt it. It is a **snapshot of the NARPM® Trust COA standard captured in June 2026**, not the live source of truth. The standard is maintained and can change, so always verify account numbers and names against the **current** official standard at **pmtrustcoa.com** before an operator commits changes, and tell the operator to do the same. Source: NARPM® Trust Chart of Accounts Standard, **produced by ProfitCoach & Crane and presented by NARPM®** (pmtrustcoa.com). © 2026 ProfitCoach & Crane. All rights reserved. NARPM® is a registered trademark of the National Association of Residential Property Managers; this skill is an adoption aid, not an official NARPM, ProfitCoach, or Crane product.

---

## How the agent uses it

1. **Get the operator's current GL accounts.** Ask them to export their chart of accounts from their accounting system as a spreadsheet (number, name, type, and ideally 12-month activity). In **AppFolio** this is `Accounting > GL Accounts`; other systems have an equivalent GL-accounts or chart-of-accounts screen.
2. **Map each current account** to a NARPM account from the standard below. Match on meaning, not on the operator's existing number. Mark every line with one legend symbol (below).
3. **Flag what has no NARPM equivalent.** Custom or statistical accounts that do not map go to a separate review list: keep as a subaccount under the nearest NARPM account, archive after a 12-month activity check, or refer to the operator's CPA (capital accounts, escrow specifics, and tax-authority accounts are common here).
4. **Produce the migration plan** as a table the operator can work from, grouped by section (Assets, Liabilities, Equity, Income, Expenses), plus an "archive candidates" list and the system-default reminders.
5. **Hand it back for the operator to execute.** This skill does not change anyone's books. The operator (or their bookkeeper) makes the edits and approves them. Renumbering a trust chart of accounts is a money-adjacent change; it stays operator-approved.

### Migration method (per the NARPM guide)

1. **Export a backup** of the current GL accounts before touching anything.
2. **Edit existing accounts** to the NARPM number and name where there is a direct match. Editing (rather than deleting and recreating) keeps the account's transaction history attached.
3. **Add new NARPM accounts** that do not exist yet.
4. **Archive unused accounts** with no recent activity. Run a 12-month GL report for each before archiving; if it is active, reclassify its transactions to the right NARPM account first.
5. **Mark the operator's old category / rollup accounts `DO NOT USE`** in the notes field so nothing posts to them. This applies to the PRIOR chart's parent and category accounts (by their own old numbers and names), not to the NARPM standard numbers, which are all postable leaves.

> **Timing.** Do the migration mid-month, well before the next owner-statement run, and notify owners before statements go out so a renumbered statement is not a surprise.

### Legend (mark every mapped line)

| Symbol | Meaning |
|--------|---------|
| ✅ | Direct match. Rename and renumber the existing account. |
| ➕ | New account to add. Does not exist in the current COA. |
| 🔀 | Consolidate. Several current accounts map to one NARPM account. |
| 📦 | Archive candidate. Review 12-month activity before deciding. |
| ⚠️ | Review needed. Partial match or custom handling required. |

---

## The NARPM® Trust Chart of Accounts (standard)

Target numbers and names. Map the operator's accounts onto these.

### Assets (1000–1090)

| NARPM # | Account |
|---------|---------|
| 1000 | Operating Trust Bank |
| 1010 | Security Deposit Trust Bank |
| 1020 | Undeposited Funds |
| 1030 | Credit Card Clearing |
| 1040 | Accounts Receivable - Tenants |
| 1050 | Accounts Receivable - Owners |
| 1090 | Suspense / Unapplied Cash |

### Liabilities (2000–2090, plus the 8000 series)

| NARPM # | Account |
|---------|---------|
| 2000 | Owner Payable |
| 2010 | Security Deposits Payable |
| 2015 | Owner-Held Security Deposits |
| 2020 | Prepaid Rent |
| 2030 | Tenant Credits |
| 2040 | Accounts Payable - Vendors |
| 2050 | Due to Management Company |
| 2090 | Other Liabilities |
| 8020 | Reserve Transfer In |
| 8030 | Reserve Transfer Out |
| 8110 | Security Deposit Refund |
| 8120 | Tenant Refunds / Returns |
| 8900 | Inter-Property Transfer Clearing |

### Equity (3000–3300)

| NARPM # | Account |
|---------|---------|
| 3000 | Opening Balances / Equity |
| 3100 | Owner Contribution |
| 3200 | Owner Distribution |
| 3300 | Retained Earnings |

### Income (4000–4400)

| NARPM # | Account |
|---------|---------|
| 4000 | Rent Income |
| 4005 | Subsidized Rent (Section 8) |
| 4006 | RBP Income (resident benefit package) |
| 4007 | Resident Lease Initiation Fee |
| 4008 | Tenant Renewal Fee |
| 4009 | Tenant Lease Change Fee |
| 4010 | Application Fee Income |
| 4020 | Late Fee Income |
| 4030 | NSF / Return Fee Income |
| 4040 | Pet Rent Income |
| 4041 | Non-Refundable Initial Pet Fee |
| 4050 | Lease Break / Liquidated Damages |
| 4060 | Utility Reimbursement Income |
| 4070 | Parking / Storage Income |
| 4080 | Laundry Income |
| 4090 | Other Miscellaneous Income |
| 4091 | Tenant Administration Fee |
| 4120 | Security Deposit Forfeited to Owner |
| 4200 | Tenant-Paid Fees - To PM Company |
| 4300 | Tenant-Paid Fees - To Owner |
| 4400 | Concessions |

### Expenses (5000–5800)

**Management fees and leasing**

| NARPM # | Account |
|---------|---------|
| 5000 | Management Fee Expense |
| 5005 | Lease Renewal Fee |
| 5010 | Leasing Commission Expense |
| 5015 | Lease-Only Commission |
| 5020 | Advertising & Marketing |
| 5030 | Lockbox / Showing / Access |
| 5040 | Maintenance Coordination Fee |
| 5041 | Project Coordination Fee |
| 5042 | Owner Inspection Fee |
| 5050 | Annual Tax / Technology Fee |

**Repairs and maintenance**

| NARPM # | Account |
|---------|---------|
| 5100 | Repairs & Maintenance - Interior |
| 5105 | Repairs & Maintenance - Exterior |
| 5110 | Repairs - Plumbing |
| 5120 | Repairs - Electrical |
| 5130 | Repairs - HVAC |
| 5140 | Repairs - Appliances |
| 5150 | Repairs - Garage Door |
| 5160 | Repairs - Roofing |
| 5170 | Repairs - Handyman / General |
| 5180 | Repairs - Doors / Windows |

**Property services**

| NARPM # | Account |
|---------|---------|
| 5200 | Landscaping / Yard Care |
| 5210 | Pest Control |
| 5220 | Pool / Spa Service |
| 5240 | Trash / Junk Removal |
| 5250 | Snow Removal |
| 5420 | Common Area Maintenance |

**Turnover**

| NARPM # | Account |
|---------|---------|
| 5230 | Turnover - Cleaning & Maid |
| 5231 | Turnover - Painting |
| 5232 | Turnover - Flooring |

**Utilities**

| NARPM # | Account |
|---------|---------|
| 5300 | Utilities - Water / Sewer |
| 5310 | Utilities - Garbage |
| 5320 | Utilities - Electricity |
| 5330 | Utilities - Gas |
| 5340 | Utilities - Internet / Cable |
| 5350 | Utilities - Fire / Security / Alarm |

**Fixed and recurring**

| NARPM # | Account |
|---------|---------|
| 5400 | HOA / Community Dues |
| 5410 | HOA Violations / Fines |
| 5500 | Property Taxes |
| 5510 | Insurance - Property / Landlord |
| 5520 | Licenses & Permits |

**Administrative**

| NARPM # | Account |
|---------|---------|
| 5600 | Legal & Eviction |
| 5610 | Court / Process Server Costs |
| 5615 | Shipping and Postage |
| 5620 | Bank & Merchant Fees |
| 5630 | Interest Expense (Owner) |
| 5640 | Property Marketing and Advertising |
| 5800 | Miscellaneous Expense |

**Owner-directed**

| NARPM # | Account |
|---------|---------|
| 5700 | Mortgage Payment (Owner) |

> If the operator splits mortgage interest and principal, keep those as subaccounts under 5700. Earthquake or flood insurance go as subaccounts under 5510. Key/lock replacement maps to 5100 (or a 5100 subaccount).

---

## Common mapping decisions

These come up on almost every migration. Use them as defaults, not rules.

- **Consolidate the fee sprawl.** Operators accumulate many narrow fee accounts (processing fees, admin fees, fines, key fees, month-to-month fees). Most collapse into **4091 Tenant Administration Fee** (or stay as its subaccounts). NSF variants collapse into **4030**; RBP variants into **4006**; pet admin/initial-pet fees into **4041**.
- **Move deposit refunds off Expense.** A security-deposit refund or a rent refund posted as an expense is wrong under trust accounting; move it to a Liability account (**8110** deposit refund, **8120** tenant refunds).
- **Suspense / clearing as an Asset.** A clearing account set up as a Liability should be retyped to an Asset when it maps to **1090 Suspense / Unapplied Cash**.
- **Tenant-paid fees: split by payee.** A "miscellaneous tenant income" pool usually splits into **4200** (fee retained by the PM company) vs **4300** (fee that belongs to the owner) based on who keeps it. Flag these ⚠️ for the operator to confirm per account.
- **Capital expenses are out of scope.** New appliances, new roof, new HVAC, equipment, and similar capital accounts are outside the trust COA. Mark them 📦 and refer to the operator's CPA, do not force them into the 5000 repair series.
- **Statistical accounts.** Gross potential rent, loss-to-market, vacancy, and delinquency are tracking lines, not trust accounts. Mark them 📦 and confirm whether the operator still needs them going forward.

---

## System default accounts (re-point EVERY one after renumbering)

This is where renumbering misroutes money if you are not careful. The operator's accounting system holds **default account assignments** that auto-route postings, rent, fees, deposits, owner draws, to specific GL numbers. If a default still points at an old number after you rename or archive it, every future posting through that default silently lands on the wrong or a dead account. So after the migration, walk EVERY default and re-point it to the right NARPM account. In **AppFolio** the defaults live under `Settings > Trust Account Settings`, the system default-accounts area, and within property / lease / owner settings; other systems have an equivalent defaults area.

**Balance and cash defaults**

| System default | Maps to NARPM |
|----------------|---------------|
| Operating cash | 1000 Operating Trust Bank |
| Security deposit cash | 1010 Security Deposit Trust Bank |
| Accounts receivable | 1040 Accounts Receivable - Tenants |
| Accounts payable | 2040 Accounts Payable - Vendors |
| Prepaid rent | 2020 Prepaid Rent |
| Owner contribution | 3100 Owner Contribution |
| Owner distribution | 3200 Owner Distribution |

**Posting / auto-post defaults (these route future money, the ones most often missed)**

| System default | Maps to NARPM |
|----------------|---------------|
| Rent | 4000 Rent Income |
| Late fee | 4020 Late Fee Income |
| NSF / returned payment | 4030 NSF / Return Fee Income |
| Application fee | 4010 Application Fee Income |
| Concession | 4400 Concessions |
| Security deposit held | 2010 Security Deposits Payable |
| Owner-held security deposit | 2015 Owner-Held Security Deposits |
| Security deposit release / refund | 8110 Security Deposit Refund |
| Tenant credit | 2030 Tenant Credits |
| Management fee | 5000 Management Fee Expense |
| Leasing / placement fee | 5010 Leasing Commission Expense |

> **This list is NOT exhaustive, and that is the point.** Different systems and configurations expose different defaults, so do not stop at the rows above. Open the system's default-accounts settings and verify EVERY default and auto-posting rule individually, then re-point any that still reference an old or archived number. One missed default silently misroutes real money on the next posting. When in doubt, confirm the full default set against the conversion guide for your system at pmtrustcoa.com.

## Category headers and DO NOT USE

Mark an account `DO NOT USE` only when it is a non-posting rollup the operator is retiring. Two cautions:

- **Never disable a NARPM standard account.** Every number in the standard above is a real posting account, including the range-leading ones: `5100` (Repairs & Maintenance - Interior), `5200` (Landscaping / Yard Care), `5300` (Utilities - Water/Sewer), and `5500` (Property Taxes) are postable leaves, not parents. Marking them `DO NOT USE` would leave anything mapped to them, for example key/lock replacement at 5100, with nowhere to post.
- **Do mark the operator's old prior-COA category parents `DO NOT USE`.** The rollup and category accounts from the chart they are migrating away from (by their own old numbers and names) should be archived or marked `DO NOT USE` so nothing posts to them.

If the operator's system shows a parent/child tree, group the NARPM accounts under unnumbered or separately-numbered NON-POSTING header rows for readability, but keep every numbered NARPM account postable.

---

## Notes

- **AppFolio is the worked example here**, because the default-account and GL screens are specific to it. The standard and the method apply to any property-management accounting system; substitute the equivalent GL-accounts and trust-settings screens for yours.
- **This skill ships no scripts.** The mapping is judgment over the operator's GL export, which the agent does directly. A future version could add a helper that parses a GL-export CSV and pre-suggests matches; until then, do the mapping by reading the export.
- **Verify against the live standard.** This account list is a snapshot. Confirm numbers and names against **pmtrustcoa.com** before the operator commits, and surface any difference rather than trusting this copy.

*Reference: NARPM® Trust Chart of Accounts Standard, produced by ProfitCoach & Crane, presented by NARPM® (pmtrustcoa.com). © 2026 ProfitCoach & Crane, all rights reserved. Account list captured June 2026; verify against the current standard before use.*
