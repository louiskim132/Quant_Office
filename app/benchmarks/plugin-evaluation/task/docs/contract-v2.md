# Contract v2

## Authority
Approved 2026-01-03; supersedes v1 for this fixture, including rechecks of archived
input manifests. This is a metadata-admission rule, not evidence of profitability.

## Classification
Rows have a unique string id. Return exactly `{id, eligible, reason}`. Preserve id.
Apply checks in this order:
1. Parse observedAt, availableAt and decisionAt as instants with explicit timezone.
   Missing/unparseable timestamps, or observedAt later than availableAt, yield
   `eligible: false, reason: INVALID_TIME`.
2. Anything other than kind FEATURE yields false / NOT_FEATURE.
3. Anything other than status COMPLETE yields false / INCOMPLETE.
4. availableAt later than decisionAt yields false / LATE.
5. Otherwise return true / OK. Equality is allowed. Compare instants, not strings.

## Completeness
Do not drop rejected records. A failed run is missing evidence; never turn it into
a successful observation or omit it from the inventory. Raw sources stay available.
