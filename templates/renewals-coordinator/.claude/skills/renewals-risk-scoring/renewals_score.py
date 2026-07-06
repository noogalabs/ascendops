#!/usr/bin/env python3
"""Generic residential renewal risk scoring and rent recommendation."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import sys
from typing import Dict, Iterable, List, Optional, Tuple

INTAKE_WINDOW_DAYS = 90
OVERDUE_LOOKBACK_DAYS = 90
MAX_INCREASE_PCT = 0.05
NONRENEW_LATE_THRESHOLD = 7
NONRENEW_NSF_THRESHOLD = 3

LATE_POINTS = 5
LATE_CAP = 7
NSF_POINTS = 10
NSF_CAP = 3
BALANCE_POINTS = 10
VIOLATION_POINTS = 10
INSPECTION_FINDING_POINTS = 10
DO_NOT_RENEW_POINTS = 100
BAND_MEDIUM_MIN = 25
BAND_HIGH_MIN = 50

Row = Dict[str, str]
Key = Tuple[str, str, str]


def norm(value: object) -> str:
    return str(value or "").strip().casefold()


def join_key(row: Row) -> Key:
    return (norm(row.get("property_id")), norm(row.get("unit")), norm(row.get("tenant_name")))


def parse_money(value: object, default: float = 0.0) -> float:
    text = str(value or "").strip()
    if not text:
        return default
    cleaned = re.sub(r"[^0-9.\-]", "", text)
    if cleaned in {"", ".", "-", "-."}:
        return default
    try:
        return float(cleaned)
    except ValueError:
        return default


def parse_int(value: object, default: int = 0) -> int:
    try:
        return int(parse_money(value, float(default)))
    except (TypeError, ValueError):
        return default


def parse_bool(value: object) -> bool:
    text = norm(value)
    return text in {"1", "true", "yes", "y", "on", "x", "flagged"}


def parse_date(value: object) -> Optional[dt.date]:
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    return None


def read_csv(path: Optional[str]) -> List[Row]:
    if not path:
        return []
    with open(path, newline="", encoding="utf-8-sig") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def index_rows(rows: Iterable[Row]) -> Dict[Key, Row]:
    indexed: Dict[Key, Row] = {}
    for row in rows:
        indexed[join_key(row)] = row
    return indexed


def risk_band(score: int) -> str:
    if score >= BAND_HIGH_MIN:
        return "High"
    if score >= BAND_MEDIUM_MIN:
        return "Medium"
    return "Low"


def rent_recommendation(rent: Row, human: Row) -> Tuple[float, str]:
    current = parse_money(rent.get("current_rent"))
    market = parse_money(rent.get("market_rent"), current)
    manager_comp = parse_money(human.get("manager_comp_rent"), 0.0)
    anchor = manager_comp if manager_comp > 0 else market
    anchor_name = "manager_comp_rent" if manager_comp > 0 else "market_rent"
    cap = current * (1 + MAX_INCREASE_PCT)
    proposed = min(anchor, cap) if current > 0 else anchor
    rationale = (
        f"Anchored to {anchor_name} {anchor:.2f}; capped at current_rent "
        f"{current:.2f} plus {MAX_INCREASE_PCT:.0%} = {cap:.2f}."
    )
    return round(proposed, 2), rationale


def score_record(rent: Row, delinquency: Row, human: Row, today: dt.date) -> Dict[str, object]:
    late = parse_int(delinquency.get("late_count_12mo"))
    nsf = parse_int(delinquency.get("nsf_count_12mo"))
    balance = parse_money(delinquency.get("outstanding_balance"))
    violations = str(human.get("violations_summary") or "").strip()
    inspection_findings = str(human.get("inspection_findings") or "").strip()
    do_not_renew = parse_bool(human.get("do_not_renew_flag"))

    score = min(late, LATE_CAP) * LATE_POINTS
    score += min(nsf, NSF_CAP) * NSF_POINTS
    if balance > 0:
        score += BALANCE_POINTS
    if violations:
        score += VIOLATION_POINTS
    if inspection_findings:
        score += INSPECTION_FINDING_POINTS
    if do_not_renew:
        score += DO_NOT_RENEW_POINTS

    band = risk_band(score)
    proposed, cma = rent_recommendation(rent, human)
    expiry = parse_date(rent.get("lease_expiry"))
    days_to_expiry = (expiry - today).days if expiry else None
    in_window = days_to_expiry is not None and 0 <= days_to_expiry <= INTAKE_WINDOW_DAYS
    overdue = days_to_expiry is not None and -OVERDUE_LOOKBACK_DAYS <= days_to_expiry < 0

    escalations: List[str] = []
    if overdue:
        # Signed renewals move lease_expiry forward, so a past-expiry row is an unsigned holdover.
        escalations.append(f"OVERDUE: lease expired {abs(days_to_expiry)}d ago, no signed renewal (holdover)")
    if "key_on_file" in human and not parse_bool(human.get("key_on_file")):
        escalations.append("no key on file")
    if parse_bool(rent.get("section8")) or parse_bool(delinquency.get("section8")):
        escalations.append("Section 8")
    if parse_bool(human.get("pet_on_file")) and norm(human.get("pet_screening_status")) not in {"complete", "approved", "current"}:
        escalations.append("pet-screening gap")

    if do_not_renew:
        recommendation = "NonRenewal"
        rationale = "Do-not-renew flag forces manager review for NonRenewal."
    elif late >= NONRENEW_LATE_THRESHOLD or nsf >= NONRENEW_NSF_THRESHOLD:
        recommendation = "NonRenewal"
        rationale = "Payment history meets configured NonRenewal review threshold."
    elif band == "High":
        recommendation = "MonthToMonth"
        rationale = "High risk band; use MonthToMonth or NonRenewal caution pending manager decision."
    else:
        recommendation = "Renew"
        rationale = "Risk band does not trigger NonRenewal or MonthToMonth caution."

    return {
        "tenant_name": rent.get("tenant_name", ""),
        "unit": rent.get("unit", ""),
        "property_id": rent.get("property_id", ""),
        "lease_expiry": rent.get("lease_expiry", ""),
        "days_to_expiry": days_to_expiry,
        "in_intake_window": in_window,
        "overdue": overdue,
        "current_rent": parse_money(rent.get("current_rent")),
        "market_rent": parse_money(rent.get("market_rent")),
        "proposed_rent": proposed,
        "cma_rationale": cma,
        "late_count_12mo": late,
        "nsf_count_12mo": nsf,
        "outstanding_balance": balance,
        "risk_score": score,
        "risk_band": band,
        "agent_recommendation": recommendation,
        "recommendation_rationale": rationale,
        "stage1_escalations": escalations,
    }


def demo_rows() -> Tuple[List[Row], List[Row], List[Row]]:
    rent_roll = [
        {"tenant_name": "Alice Renew", "unit": "12A", "property_id": "P-100", "current_rent": "$1,700", "market_rent": "$1,820", "lease_expiry": "2026-08-15", "bed_bath_sqft": "2/1 900", "section8": "no"},
        {"tenant_name": "Bob Latepay", "unit": "3B", "property_id": "P-100", "current_rent": "1500", "market_rent": "1625", "lease_expiry": "2026-09-01", "bed_bath_sqft": "1/1 700", "section8": "no"},
        {"tenant_name": "Casey Assist", "unit": "8C", "property_id": "P-200", "current_rent": "1200", "market_rent": "1285", "lease_expiry": "2026-07-20", "bed_bath_sqft": "1/1 650", "section8": "yes"},
        {"tenant_name": "Devon Review", "unit": "4D", "property_id": "P-200", "current_rent": "2100", "market_rent": "2300", "lease_expiry": "2026-12-01", "bed_bath_sqft": "3/2 1300", "section8": "no"},
        {"tenant_name": "Erin Caution", "unit": "5E", "property_id": "P-100", "current_rent": "1400", "market_rent": "1500", "lease_expiry": "2026-08-10", "bed_bath_sqft": "2/1 850", "section8": "no"},
        {"tenant_name": "Grace Holdover", "unit": "9F", "property_id": "P-300", "current_rent": "1600", "market_rent": "1680", "lease_expiry": "2026-06-15", "bed_bath_sqft": "2/2 950", "section8": "no"},
    ]
    delinquency = [
        {"tenant_name": "Bob Latepay", "unit": "3B", "property_id": "P-100", "late_count_12mo": "8", "nsf_count_12mo": "1", "outstanding_balance": "$250", "last_payment_date": "2026-06-20", "section8": "no"},
        {"tenant_name": "Casey Assist", "unit": "8C", "property_id": "P-200", "late_count_12mo": "2", "nsf_count_12mo": "0", "outstanding_balance": "0", "last_payment_date": "2026-06-25", "section8": "yes"},
        {"tenant_name": "Devon Review", "unit": "4D", "property_id": "P-200", "late_count_12mo": "1", "nsf_count_12mo": "3", "outstanding_balance": "0", "last_payment_date": "2026-06-28", "section8": "no"},
        {"tenant_name": "Erin Caution", "unit": "5E", "property_id": "P-100", "late_count_12mo": "6", "nsf_count_12mo": "2", "outstanding_balance": "0", "last_payment_date": "2026-06-22", "section8": "no"},
    ]
    human = [
        {"tenant_name": "Alice Renew", "unit": "12A", "property_id": "P-100", "key_on_file": "yes", "pet_on_file": "no", "pet_screening_status": "", "do_not_renew_flag": "no", "violations_summary": "", "inspection_status": "complete", "inspection_findings": "", "manager_comp_rent": ""},
        {"tenant_name": "Bob Latepay", "unit": "3B", "property_id": "P-100", "key_on_file": "no", "pet_on_file": "yes", "pet_screening_status": "missing", "do_not_renew_flag": "no", "violations_summary": "noise notices", "inspection_status": "pending", "inspection_findings": "", "manager_comp_rent": "1600"},
        {"tenant_name": "Casey Assist", "unit": "8C", "property_id": "P-200", "key_on_file": "yes", "pet_on_file": "yes", "pet_screening_status": "complete", "do_not_renew_flag": "yes", "violations_summary": "", "inspection_status": "complete", "inspection_findings": "damage review", "manager_comp_rent": ""},
        {"tenant_name": "Devon Review", "unit": "4D", "property_id": "P-200", "key_on_file": "yes", "pet_on_file": "no", "pet_screening_status": "", "do_not_renew_flag": "no", "violations_summary": "", "inspection_status": "complete", "inspection_findings": "", "manager_comp_rent": ""},
        {"tenant_name": "Erin Caution", "unit": "5E", "property_id": "P-100", "key_on_file": "yes", "pet_on_file": "no", "pet_screening_status": "", "do_not_renew_flag": "no", "violations_summary": "", "inspection_status": "complete", "inspection_findings": "", "manager_comp_rent": ""},
        {"tenant_name": "Grace Holdover", "unit": "9F", "property_id": "P-300", "key_on_file": "yes", "pet_on_file": "no", "pet_screening_status": "", "do_not_renew_flag": "no", "violations_summary": "", "inspection_status": "complete", "inspection_findings": "", "manager_comp_rent": ""},
    ]
    return delinquency, rent_roll, human


def score_rows(delinquency_rows: List[Row], rent_rows: List[Row], human_rows: List[Row], today: dt.date) -> List[Dict[str, object]]:
    delinq_by_key = index_rows(delinquency_rows)
    human_by_key = index_rows(human_rows)
    results: List[Dict[str, object]] = []
    for rent in rent_rows:
        key = join_key(rent)
        clean_delinq: Row = {
            "tenant_name": rent.get("tenant_name", ""),
            "unit": rent.get("unit", ""),
            "property_id": rent.get("property_id", ""),
            "late_count_12mo": "0",
            "nsf_count_12mo": "0",
            "outstanding_balance": "0",
            "last_payment_date": "",
            "section8": rent.get("section8", ""),
        }
        results.append(score_record(rent, delinq_by_key.get(key, clean_delinq), human_by_key.get(key, {}), today))
    return results


def print_table(results: List[Dict[str, object]]) -> None:
    fields = ["tenant_name", "unit", "property_id", "lease_expiry", "risk_score", "risk_band", "proposed_rent", "agent_recommendation", "stage1_escalations"]
    widths = {field: max(len(field), *(len(str(row.get(field, ""))) for row in results)) for field in fields}
    print(" | ".join(field.ljust(widths[field]) for field in fields))
    print("-+-".join("-" * widths[field] for field in fields))
    for row in results:
        print(" | ".join(str(row.get(field, "")).ljust(widths[field]) for field in fields))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Score residential lease renewals and recommend capped rent.")
    parser.add_argument("--demo", action="store_true", help="Use built-in synthetic demo rows.")
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    parser.add_argument("--delinquency", help="CSV with delinquency fields.")
    parser.add_argument("--rent-roll", help="CSV with rent roll fields.")
    parser.add_argument("--human", help="Optional CSV with human-review fields.")
    parser.add_argument("--today", help="Override today's date as YYYY-MM-DD for deterministic scoring.")
    args = parser.parse_args(argv)

    today = parse_date(args.today) if args.today else dt.date.today()
    if today is None:
        parser.error("--today must be YYYY-MM-DD, MM/DD/YYYY, or MM/DD/YY")

    if args.demo:
        delinquency_rows, rent_rows, human_rows = demo_rows()
    else:
        rent_rows = read_csv(args.rent_roll)
        delinquency_rows = read_csv(args.delinquency)
        human_rows = read_csv(args.human)
        if not rent_rows:
            parser.error("--rent-roll is required unless --demo is used")

    results = score_rows(delinquency_rows, rent_rows, human_rows, today)
    if args.json:
        print(json.dumps(results, indent=2, sort_keys=True))
    else:
        print_table(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
