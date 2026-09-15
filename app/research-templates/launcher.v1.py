"""launcher.v1 - the fixed launcher inside an exported Quant Research Office run package.

The office exports a frozen package; the user carries it to Colab, runs the experiment the
package instructions describe, and then runs this file in the package directory. This launcher
is the one piece of the run the office fixes: it verifies the package bytes it shipped with,
runs the authored check templates in their documented order (data, diagnostics, portfolio,
cost), hashes every produced file it binds, and writes the return the office can admit:

    return-manifest.json   the bound RUN_RETURN manifest (schemaVersion 1)
    run-return.zip         that manifest plus exactly the declared produced files

Check inputs. Each authored check reads one optional input document: the first file named
<id>.input.json found under the package root, whether it shipped inside the package or the run
produced it. The documented shapes are

    data.input.json         {"spec": {...}, "columns": [...], "rows": n}
    diagnostics.input.json  {"predictions": [...], "targets": [...], "metric": "RANK_IC"}
    portfolio.input.json    {"periods": [{period, weightsBefore, weightsAfter, assetReturns}]}
    cost.input.json         {"periods": [...]}

The portfolio contract and the cost model are read from the package's own frozen JSON entries
whenever they are present there; a "contract" or "costs" member inside the input document is a
fallback, and a difference between the two is reported rather than silently resolved. Every gate
verdict is computed inside this file from the shipped check code - the run never asserts its own
PASS. A gate whose inputs are absent is BLOCKED; a check that cannot run is a recorded failed
attempt, not a quiet zero.

Failed attempts. A file named failed-runs.json may carry earlier failed tries as
[{"reason": ..., "failedAt": ...}]; valid entries are carried into the return's failedRuns so a
selected ledger cannot be returned.

This file is deliberately standard-library only. It opens no outbound channel of any kind: no
remote calls, no credentials, no agent API use, no callbacks and no listener of any sort. It
edits no package file and writes nothing outside the two return files above. Run it once: a
second run is a different runId, and the office refuses conflicting returns rather than merging
them.
"""
import contextlib
import hashlib
import io
import json
import math
import re
import runpy
import sys
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

SCHEMA_VERSION = 1
TEMPLATE_VERSION = "1.0.0"

PACKAGE_MANIFEST = "MANIFEST.json"
RETURN_MANIFEST = "return-manifest.json"
RETURN_BUNDLE = "run-return.zip"
FAILED_RUNS_DOC = "failed-runs.json"
CHECK_ORDER = ("data", "diagnostics", "portfolio", "cost")
CHECK_FILE = re.compile(r"^(data|diagnostics|portfolio|cost)\.v([0-9]+)\.py$")
VERSION_DECL = re.compile(r'TEMPLATE_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"')

# A returned gate row may only name the stage that owns the gate in the office's stage-gate
# table: G-ARTIFACT in S3, G-PORTFOLIO in S5, G-COST and G-ECON in S6, G-INTEGRITY in S8. A
# required gate outside this set cannot be represented in a RUN_RETURN manifest at all, and a
# package that requires one is a build defect, not a run result.
GATE_RETURN_STAGE = {
    "G-ARTIFACT": "S3",
    "G-PORTFOLIO": "S5",
    "G-COST": "S6",
    "G-ECON": "S6",
    "G-INTEGRITY": "S8",
}
MAX_ARTIFACTS = 512
MAX_GATES = 64
MAX_FAILED_RUNS = 500
MAX_TEXT = 4000
MAX_REASON = 1000
MAX_WALK = 50000


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _clip(value, limit=MAX_TEXT):
    return str(value)[:limit]


def _safe_relpath(raw):
    """A package path is a forward-slash relative path. Anything else is refused, not repaired."""
    if not isinstance(raw, str) or not raw or "\\" in raw:
        return None
    if re.match(r"^[A-Za-z]:", raw):
        return None
    pure = PurePosixPath(raw)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    return str(pure)


def _is_run_package_manifest(path):
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    return isinstance(doc, dict) and doc.get("kind") == "RUN_PACKAGE" and doc.get("schemaVersion") == 1


def _find_package_root(start):
    """The package root is the directory holding MANIFEST.json - here, or one unzip level down."""
    candidates = []
    direct = start / PACKAGE_MANIFEST
    if direct.is_file() and _is_run_package_manifest(direct):
        candidates.append(start)
    for pattern in ("*/" + PACKAGE_MANIFEST, "*/*/" + PACKAGE_MANIFEST):
        for candidate in sorted(start.glob(pattern)):
            if candidate.is_file() and _is_run_package_manifest(candidate):
                candidates.append(candidate.parent)
    unique = sorted({str(item) for item in candidates})
    return Path(unique[0]) if len(unique) == 1 else None


def _verify_entries(root, entries):
    """Every declared member must exist with exactly its declared bytes before anything runs."""
    problems = []
    seen = set()
    if not entries:
        problems.append("the package declares no entries")
    if len(entries) > MAX_ARTIFACTS:
        problems.append(f"the package declares {len(entries)} entries, over the {MAX_ARTIFACTS} cap")
    for entry in entries:
        rel = _safe_relpath(entry.get("path") if isinstance(entry, dict) else None)
        if rel is None or rel in seen:
            problems.append(f"unsafe or duplicate package path {entry!r}"[:400])
            continue
        seen.add(rel)
        target = (root / rel).resolve()
        try:
            inside = target.is_file() and target.is_relative_to(root.resolve())
        except OSError:
            inside = False
        if not inside:
            problems.append(f"{rel} is missing or not a file inside the package")
            continue
        data = target.read_bytes()
        if len(data) != entry.get("bytes"):
            problems.append(f"{rel} is {len(data)} bytes where the package declares {entry.get('bytes')}")
        elif _sha256(data) != str(entry.get("sha256", "")).lower():
            problems.append(f"{rel} does not match its declared sha256")
    return problems


def _find_check(root, entries, check_id):
    """The newest versioned file the package ships for this check id, or None."""
    best = None
    for entry in entries:
        rel = _safe_relpath(entry.get("path") if isinstance(entry, dict) else None)
        if rel is None:
            continue
        match = CHECK_FILE.match(PurePosixPath(rel).name)
        if match and match.group(1) == check_id and (best is None or int(match.group(2)) > best[0]):
            best = (int(match.group(2)), root / rel, rel)
    return best


def _run_check(found, check_id):
    """Execute one authored template as __main__; its self-report must match its file identity."""
    major, path, rel = found
    capture = io.StringIO()
    try:
        with contextlib.redirect_stdout(capture):
            namespace = runpy.run_path(str(path), run_name="__main__")
    except Exception as exc:
        return None, f"{rel} did not run cleanly: {type(exc).__name__}: {exc}"
    report = None
    try:
        report = json.loads(capture.getvalue().strip())
    except Exception:
        pass
    source = path.read_bytes()
    declared = VERSION_DECL.search(source.decode("utf-8", "replace"))
    if not isinstance(report, dict) or report.get("template") != check_id:
        return None, f"{rel} ran but did not emit its own identity report."
    if not declared or report.get("version") != declared.group(1):
        return None, f"{rel} reports version {report.get('version')!r} but declares {declared and declared.group(1)!r}."
    if int(str(report["version"]).split(".")[0]) != major:
        return None, f"{rel} reports version {report['version']!r}, which does not match its filename."
    return {"ns": namespace, "version": report["version"], "sha256": _sha256(source), "path": rel}, None


def _find_input(root, check_id):
    """The first <id>.input.json under the package root, shipped by the package or produced by the run."""
    hits = sorted(item for item in root.rglob(f"{check_id}.input.json") if item.is_file())
    if not hits:
        return None, None, None
    try:
        return json.loads(hits[0].read_text(encoding="utf-8")), hits[0], None
    except Exception as exc:
        return None, hits[0], f"{type(exc).__name__}: {exc}"


def _find_frozen(root, entries, keys, required):
    """Frozen config lives in the package's JSON entries, under a recognised key or at top level."""
    for entry in entries:
        rel = _safe_relpath(entry.get("path") if isinstance(entry, dict) else None)
        if rel is None or not rel.endswith(".json") or rel in (PACKAGE_MANIFEST, RETURN_MANIFEST):
            continue
        try:
            doc = json.loads((root / rel).read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(doc, dict):
            continue
        for key in keys:
            inner = doc.get(key)
            if isinstance(inner, dict) and all(isinstance(inner.get(f), (int, float)) for f in required):
                return inner, f"{rel}:{key}"
        if all(isinstance(doc.get(f), (int, float)) for f in required):
            return doc, rel
    return None, None


def _finite_map(value):
    return isinstance(value, dict) and all(
        isinstance(v, (int, float)) and math.isfinite(v) for v in value.values())


def _shaped(doc, required):
    return isinstance(doc, dict) and all(isinstance(doc.get(f), (int, float)) and math.isfinite(doc[f]) for f in required)


def _periods_from(doc):
    """Normalise a periods list; a malformed entry makes the whole input unreadable, not partially so."""
    periods = doc.get("periods") if isinstance(doc, dict) else None
    if not isinstance(periods, list):
        return None
    out = []
    for raw in periods:
        if not isinstance(raw, dict):
            return None
        label = raw.get("period", raw.get("label"))
        before, after, returns = raw.get("weightsBefore"), raw.get("weightsAfter"), raw.get("assetReturns")
        if not isinstance(label, str) or not all(map(_finite_map, (before, after, returns))):
            return None
        out.append({"period": label, "weightsBefore": before, "weightsAfter": after, "assetReturns": returns})
    return out


def _verdict(outcome, detail, rationale):
    return {"outcome": outcome, "detail": _clip(detail), "rationale": _clip(rationale)}


def _eval_portfolio(periods, contract):
    """G-PORTFOLIO: the frozen exposure and turnover limits against what was actually held."""
    if not periods:
        return _verdict("BLOCKED", "No periods were supplied, so exposure cannot be checked.",
                        "The check requires the run's declared periods and the frozen portfolio contract.")
    for period in periods:
        after, before = period["weightsAfter"], period["weightsBefore"]
        gross = sum(abs(v) for v in after.values())
        net = abs(sum(after.values()))
        largest = max([abs(v) for v in after.values()] or [0.0])
        turnover = sum(abs(after.get(a, 0.0) - before.get(a, 0.0)) for a in set(after) | set(before))
        for name, observed, permitted in (
                ("gross exposure", gross, contract["maxGrossExposure"]),
                ("net exposure", net, contract["maxNetExposure"]),
                ("position weight", largest, contract["maxPositionWeight"]),
                ("turnover", turnover, contract["maxTurnoverPerPeriod"])):
            if observed > permitted:
                return _verdict("FAIL",
                                f"Period {period['period']} breaches the frozen {name} limit: {observed} against {permitted}.",
                                "Computed by the portfolio check inside the bound package.")
    return _verdict("PASS", f"All {len(periods)} periods stay inside the frozen exposure and turnover limits.",
                    "Computed by the portfolio check inside the bound package.")


def _eval_cost(periods, costs, economics):
    """G-COST / G-ECON: the frozen cost model applied per period, exactly as cost.v1 computes it."""
    if not periods:
        verdict = _verdict("BLOCKED", "No periods were supplied, so no net result can be computed.",
                           "The check requires the run's declared periods and the frozen cost model.")
        return verdict, verdict
    results = []
    for period in periods:
        outcome = economics(period, costs)
        if not isinstance(outcome, dict):
            verdict = _verdict("BLOCKED", "The cost check returned nothing usable for a period.",
                               "Computed by the cost check inside the bound package.")
            return verdict, verdict
        if "unpriced" in outcome:
            missing = ", ".join(sorted(outcome["unpriced"])[:5])
            verdict = _verdict("BLOCKED",
                               f"Period {period['period']} cannot be priced: held assets have no return ({missing}). Missing returns are not treated as zero.",
                               "Computed by the cost check inside the bound package.")
            return verdict, verdict
        if not all(math.isfinite(outcome.get(key, float("nan"))) for key in ("gross", "turnover", "cost", "net")):
            verdict = _verdict("FAIL", f"Period {period['period']} produced a non-finite economic figure.",
                               "Computed by the cost check inside the bound package.")
            return verdict, verdict
        results.append(outcome)
    gross = sum(item["gross"] for item in results)
    cost = sum(item["cost"] for item in results)
    net = gross - cost
    count = len(results)
    cost_verdict = _verdict(
        "PASS" if net > 0 else "FAIL",
        f"Net of costs the run returns {net:.6f} across {count} periods." if net > 0 else
        f"Costs of {cost:.6f} meet or exceed the gross {gross:.6f} across {count} periods, so there is no net result to carry forward.",
        "Computed by the cost check inside the bound package.")
    econ_verdict = _verdict(
        "PASS", f"Per-period economics were computed for all {count} periods; cumulative net {net:.6f}.",
        "Computed by the cost check inside the bound package; PASS here means the economics exist and are complete, not that they are positive.")
    return cost_verdict, econ_verdict


class _Columns:
    """The smallest frame the data template reads: column names and a row count."""

    def __init__(self, columns, rows):
        self.columns = list(columns)
        self._rows = int(rows)

    def __len__(self):
        return self._rows


def _drive_check(check_id, run, doc):
    """Feed the check's documented input to the shipped function; the output is evidence, not verdict."""
    ns = run["ns"]
    if check_id == "data":
        spec = doc.get("spec") if isinstance(doc, dict) else None
        columns, rows = (doc.get("columns"), doc.get("rows")) if isinstance(doc, dict) else (None, None)
        if not isinstance(spec, dict) or not isinstance(columns, list) or not isinstance(rows, int):
            return None, "the input needs spec, columns and rows"
        return ns["manifest"](_Columns(columns, rows), spec), None
    if check_id == "diagnostics":
        predictions = doc.get("predictions") if isinstance(doc, dict) else None
        targets = doc.get("targets") if isinstance(doc, dict) else None
        if not isinstance(predictions, list) or not isinstance(targets, list):
            return None, "the input needs predictions and targets lists"
        metric = doc.get("metric", "RANK_IC")
        return ns["signal"](predictions, targets, metric), None
    if check_id == "portfolio":
        periods = _periods_from(doc)
        if periods is None:
            return None, "the input needs a periods list of period/weightsBefore/weightsAfter/assetReturns"
        return [ns["period"](p["period"], p["weightsBefore"], p["weightsAfter"], p["assetReturns"]) for p in periods], None
    if check_id == "cost":
        periods = _periods_from(doc)
        if periods is None:
            return None, "the input needs a periods list of period/weightsBefore/weightsAfter/assetReturns"
        return periods, None
    return None, "no driver"


def _read_failed_runs(root, failed):
    """Carry earlier failed attempts the run recorded, so a selected ledger cannot be returned."""
    hits = sorted(item for item in root.rglob(FAILED_RUNS_DOC) if item.is_file())
    if not hits:
        return
    try:
        doc = json.loads(hits[0].read_text(encoding="utf-8"))
    except Exception as exc:
        failed.append({"reason": _clip(f"{FAILED_RUNS_DOC} could not be read: {type(exc).__name__}", MAX_REASON),
                       "failedAt": _now()})
        return
    entries = doc if isinstance(doc, list) else doc.get("failedRuns") if isinstance(doc, dict) else None
    if not isinstance(entries, list):
        return
    for item in entries:
        if len(failed) >= MAX_FAILED_RUNS:
            return
        if not isinstance(item, dict) or not isinstance(item.get("reason"), str) or not item["reason"].strip():
            continue
        when = item.get("failedAt")
        try:
            parsed = datetime.fromisoformat(str(when).replace("Z", "+00:00"))
        except Exception:
            continue
        failed.append({"reason": _clip(item["reason"].strip(), MAX_REASON),
                       "failedAt": parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")})


def _collect_artifacts(root, expected_files):
    """Bind exactly the produced files the package declared; undeclared output cannot travel."""
    artifacts, missing, seen = [], [], set()
    for raw in expected_files:
        rel = _safe_relpath(raw)
        if rel is None or rel in (PACKAGE_MANIFEST, RETURN_MANIFEST, RETURN_BUNDLE) or rel in seen:
            missing.append(raw if isinstance(raw, str) else repr(raw))
            continue
        seen.add(rel)
        target = (root / rel).resolve()
        try:
            data = target.read_bytes() if target.is_file() and target.is_relative_to(root.resolve()) else None
        except OSError:
            data = None
        if data is None:
            missing.append(rel)
        else:
            artifacts.append({"path": rel, "sha256": _sha256(data), "bytes": len(data)})
    return artifacts[:MAX_ARTIFACTS], missing


def _undeclared_count(root, entries, expected_files):
    declared = {rel for rel in (_safe_relpath(e.get("path")) for e in entries if isinstance(e, dict)) if rel}
    declared.update(f for f in (_safe_relpath(x) for x in expected_files) if f)
    declared.update({PACKAGE_MANIFEST, RETURN_MANIFEST, RETURN_BUNDLE})
    count, walked = 0, 0
    for item in root.rglob("*"):
        walked += 1
        if walked > MAX_WALK:
            break
        if not item.is_file():
            continue
        rel = item.relative_to(root).as_posix()
        if any(part.startswith(".") for part in PurePosixPath(rel).parts):
            continue
        if rel not in declared:
            count += 1
    return count


def _gate_rows(required, verdicts):
    rows, unanswerable, emitted = [], [], set()
    for gate in required:
        stage = GATE_RETURN_STAGE.get(gate)
        if stage is None:
            unanswerable.append(gate)
            continue
        verdict = verdicts.get(gate) or _verdict(
            "BLOCKED", f"The run produced no answerable evidence for {gate}.",
            "No shipped check answered this gate inside the package.")
        rows.append({"gate": gate, "stage": stage, **verdict})
        emitted.add(gate)
    for gate in sorted(verdicts):
        if gate not in emitted and gate in GATE_RETURN_STAGE and len(rows) < MAX_GATES:
            rows.append({"gate": gate, "stage": GATE_RETURN_STAGE[gate], **verdicts[gate]})
    return rows[:MAX_GATES], unanswerable


def _write_return(root, manifest, status, artifacts, gates, failed, detail, started):
    finished = _now()
    document = {
        "schemaVersion": SCHEMA_VERSION, "kind": "RUN_RETURN",
        "packageId": manifest["packageId"], "packageHash": manifest["packageHash"],
        "branchId": manifest["branchId"], "specId": manifest["specId"],
        "specHash": manifest["specHash"], "subjectHash": manifest["subjectHash"],
        "runId": f"user-run-{uuid.uuid4()}", "startedAt": started, "finishedAt": finished,
        "status": status, "artifacts": artifacts, "gates": gates,
        "failedRuns": failed[:MAX_FAILED_RUNS], "detail": _clip(detail),
    }
    encoded = json.dumps(document, indent=2, sort_keys=True).encode("utf-8")
    (root / RETURN_MANIFEST).write_bytes(encoded)
    with zipfile.ZipFile(root / RETURN_BUNDLE, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(RETURN_MANIFEST, encoded)
        for artifact in artifacts:
            bundle.write(root / artifact["path"], artifact["path"])
    return document


def main():
    start = Path.cwd()
    root = _find_package_root(start)
    if root is None:
        print(f"No single RUN_PACKAGE {PACKAGE_MANIFEST} was found at or just below {start}. "
              "Run this file inside the unpacked package directory.")
        return 2
    try:
        manifest = json.loads((root / PACKAGE_MANIFEST).read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"{PACKAGE_MANIFEST} could not be read: {type(exc).__name__}: {exc}")
        return 2
    identity = ("packageId", "packageHash", "branchId", "specId", "specHash", "subjectHash")
    expected = manifest.get("expectedReturn") if isinstance(manifest, dict) else None
    if (not isinstance(manifest, dict) or manifest.get("kind") != "RUN_PACKAGE"
            or manifest.get("schemaVersion") != SCHEMA_VERSION
            or any(not isinstance(manifest.get(key), str) for key in identity)
            or not isinstance(manifest.get("entries"), list) or not isinstance(expected, dict)
            or not isinstance(expected.get("files"), list) or not isinstance(expected.get("requiredGates"), list)):
        print(f"{PACKAGE_MANIFEST} is not a complete RUN_PACKAGE manifest; nothing was run and no return was written.")
        return 2

    started = _now()
    entries = manifest["entries"]
    expected_files = expected["files"]
    required = [gate for gate in expected["requiredGates"] if isinstance(gate, str)]
    problems = _verify_entries(root, entries)
    artifacts, missing_files = _collect_artifacts(root, expected_files)
    failed, notes, verdicts = [], [], {}

    if problems:
        failed.append({"reason": _clip("Package integrity verification failed: " + "; ".join(problems[:5]), MAX_REASON),
                       "failedAt": started})
        verdicts["G-ARTIFACT"] = _verdict(
            "FAIL", f"{len(problems)} package entr{'y' if len(problems) == 1 else 'ies'} failed verification: " + "; ".join(problems[:3]),
            "The launcher's own transfer check: every declared member must match its recorded sha256 and size before anything runs.")
    else:
        verdicts["G-ARTIFACT"] = _verdict(
            "PASS", f"All {len(entries)} package entries match their declared sha256 and size.",
            "The launcher's own transfer check, run before any check executed.")
        for check_id in CHECK_ORDER:
            found = _find_check(root, entries, check_id)
            if found is None:
                notes.append(f"{check_id}: package ships no check template")
                continue
            run, error = _run_check(found, check_id)
            if error:
                notes.append(f"{check_id}: {error}")
                failed.append({"reason": _clip(f"{check_id} check failed: {error}", MAX_REASON), "failedAt": _now()})
                continue
            doc, at, error = _find_input(root, check_id)
            if error:
                notes.append(f"{check_id}: input at {at} unreadable ({error})")
                failed.append({"reason": _clip(f"{check_id} input unreadable: {error}", MAX_REASON), "failedAt": _now()})
                continue
            if doc is None:
                notes.append(f"{check_id}: {run['version']} ran; no {check_id}.input.json, so it answered nothing further")
                continue
            input_ref = f"{at.relative_to(root).as_posix()} sha256 {_sha256(at.read_bytes())[:12]}"
            try:
                output, error = _drive_check(check_id, run, doc)
            except Exception as exc:
                output, error = None, f"{type(exc).__name__}: {exc}"
            if error:
                notes.append(f"{check_id}: input at {input_ref} not usable ({error})")
                failed.append({"reason": _clip(f"{check_id} input not usable: {error}", MAX_REASON), "failedAt": _now()})
                continue
            notes.append(f"{check_id}: {run['version']} ran over {input_ref}")
            if check_id == "portfolio":
                contract, source = _find_frozen(root, entries,
                                              ("portfolioContract", "portfolio", "contract"),
                                              ("maxGrossExposure", "maxNetExposure", "maxPositionWeight", "maxTurnoverPerPeriod"))
                offered = doc.get("contract", doc.get("portfolioContract")) if isinstance(doc, dict) else None
                if not _shaped(offered, ("maxGrossExposure", "maxNetExposure", "maxPositionWeight", "maxTurnoverPerPeriod")):
                    offered = None
                if contract is None and offered is not None:
                    contract, source = offered, "the check input (no frozen copy found in the package)"
                elif contract is not None and offered is not None and offered != contract:
                    notes.append("portfolio: the input's contract differs from the frozen package contract; the frozen one was applied")
                if contract is None:
                    verdicts["G-PORTFOLIO"] = _verdict(
                        "BLOCKED", "No frozen portfolio contract was found in the package or the check input.",
                        "Exposure limits are a frozen input; without them the check cannot be computed.")
                else:
                    try:
                        verdicts["G-PORTFOLIO"] = _eval_portfolio(output, contract)
                    except Exception as exc:
                        failed.append({"reason": _clip(f"portfolio gate evaluation failed: {type(exc).__name__}: {exc}", MAX_REASON),
                                       "failedAt": _now()})
                        verdicts["G-PORTFOLIO"] = _verdict("BLOCKED", "The portfolio check could not be evaluated.",
                                                           "The shipped check raised on the run's input.")
                    verdicts["G-PORTFOLIO"]["rationale"] += f" Contract from {source}."
            if check_id == "cost":
                costs, source = _find_frozen(root, entries, ("costs", "costModel", "cost"),
                                             ("commissionBps", "halfSpreadBps", "slippageBps",
                                              "borrowBpsPerPeriod", "financingBpsPerPeriod"))
                offered = doc.get("costs", doc.get("costModel")) if isinstance(doc, dict) else None
                if not _shaped(offered, ("commissionBps", "halfSpreadBps", "slippageBps",
                                         "borrowBpsPerPeriod", "financingBpsPerPeriod")):
                    offered = None
                if costs is None and offered is not None:
                    costs, source = offered, "the check input (no frozen copy found in the package)"
                elif costs is not None and offered is not None and offered != costs:
                    notes.append("cost: the input's cost model differs from the frozen package cost model; the frozen one was applied")
                economics = run["ns"].get("economics")
                if costs is None:
                    blocked = _verdict("BLOCKED", "No frozen cost model was found in the package or the check input.",
                                       "The cost model is a frozen input; without it no net result can be computed.")
                    verdicts["G-COST"], verdicts["G-ECON"] = blocked, dict(blocked)
                elif not callable(economics):
                    blocked = _verdict("BLOCKED", "The shipped cost template carries no economics function.",
                                       "The check file verified and ran but exposed nothing to call.")
                    verdicts["G-COST"], verdicts["G-ECON"] = blocked, dict(blocked)
                else:
                    try:
                        cost_verdict, econ_verdict = _eval_cost(output, costs, economics)
                    except Exception as exc:
                        failed.append({"reason": _clip(f"cost gate evaluation failed: {type(exc).__name__}: {exc}", MAX_REASON),
                                       "failedAt": _now()})
                        blocked = _verdict("BLOCKED", "The cost check could not be evaluated.",
                                           "The shipped check raised on the run's input.")
                        cost_verdict, econ_verdict = dict(blocked), dict(blocked)
                    cost_verdict["rationale"] += f" Cost model from {source}."
                    econ_verdict["rationale"] += f" Cost model from {source}."
                    verdicts["G-COST"], verdicts["G-ECON"] = cost_verdict, econ_verdict
        _read_failed_runs(root, failed)

    gates, unanswerable = _gate_rows(required, verdicts)
    if unanswerable:
        notes.append(f"the package requires {', '.join(unanswerable)}, which a user-run return cannot "
                     "represent - the package is mis-built, not the run")
    if missing_files:
        failed.append({"reason": _clip("Declared return files were not produced: " + ", ".join(missing_files[:5]), MAX_REASON),
                       "failedAt": _now()})

    if problems or unanswerable or missing_files:
        status = "EXECUTION_FAILED"
    elif any(row["outcome"] == "BLOCKED" for row in gates if row["gate"] in required):
        status = "INCONCLUSIVE"
    else:
        status = "COMPLETED"

    undeclared = _undeclared_count(root, entries, expected_files)
    detail = (f"{status}: {len(artifacts)} declared file(s) bound to package {manifest['packageId']}; "
              f"{len(gates)} gate row(s) reported; checks - " + ("; ".join(notes) or "none ran") +
              (f"; {undeclared} produced file(s) outside the declared inventory were left unbound" if undeclared else "") +
              (f"; missing declared file(s): {', '.join(missing_files[:5])}" if missing_files else ""))
    document = _write_return(root, manifest, status, artifacts, gates, failed, detail, started)
    print(f"{status}: wrote {RETURN_MANIFEST} and {RETURN_BUNDLE} in {root}")
    print(f"Import {RETURN_BUNDLE} into the office as the return for package {document['packageId']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
