"""100-row application acceptance fixture. LOCAL_SIMULATION; never a real Colab or market run."""
import csv
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import random
import sys
from datetime import datetime, timedelta, timezone

def write(root, name, value):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")

def module(root, name):
    spec = importlib.util.spec_from_file_location(name, root / "templates" / (name + ".v1.py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

def generate(root):
    # Freeze the plan before generating or viewing outcomes.
    plan = {"provenance": "LOCAL_SIMULATION", "rows": 100, "seed": 20261001,
            "assets": 10, "periods": 10, "trainPeriods": [0, 1, 2, 3, 4],
            "purgedPeriods": [5], "evaluationPeriods": [6, 7, 8, 9],
            "model": "OLS intercept and one contemporaneously available synthetic feature",
            "primaryMetric": "MAE", "secondaryMetric": "pooled RANK_IC",
            "costMultiples": [1, 1.5, 2], "positionRule": "0.1 * sign(prediction)",
            "conclusionLimit": "Software acceptance only; no scientific or trading conclusion"}
    write(root, "planning-plan.json", plan)
    rng = random.Random(plan["seed"])
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["row_id", "timestamp", "asset", "feature", "target"])
    for period in range(10):
        for asset in range(10):
            feature = rng.uniform(-1, 1)
            target = 0.006 * feature + rng.gauss(0, 0.004)
            writer.writerow([f"r{period*10+asset:03d}", (start + timedelta(hours=period)).isoformat(),
                             f"SYN{asset:02d}", f"{feature:.10f}", f"{target:.10f}"])
    (root / "input.csv").write_bytes(buffer.getvalue().encode("utf-8"))
    write(root, "check-config.json", {
        "costs": {"schemaVersion": 1, "commissionBps": 2, "halfSpreadBps": 3,
                  "slippageBps": 5, "borrowBpsPerPeriod": 4, "financingBpsPerPeriod": 1},
        "portfolioContract": {"schemaVersion": 1, "maxGrossExposure": 1.01,
                              "maxNetExposure": 1.01, "maxPositionWeight": 0.11,
                              "maxTurnoverPerPeriod": 2.01}})
    print(json.dumps({"phase": "planning_and_generation", "rows": 100, "provenance": "LOCAL_SIMULATION"}))

def analyze(root):
    sources = list((root / "inputs").rglob("input.csv"))
    assert sources
    source = sources[0].read_bytes()
    rows = list(csv.DictReader(io.StringIO(source.decode("utf-8"))))
    assert len(rows) == 100 and len({r["row_id"] for r in rows}) == 100
    times = sorted({r["timestamp"] for r in rows})
    assert len(times) == 10
    training = [r for r in rows if r["timestamp"] in times[:5]]
    evaluation = [r for r in rows if r["timestamp"] in times[6:]]
    assert len(training) == 50 and len(evaluation) == 40
    assert datetime.fromisoformat(times[4]) + timedelta(hours=1) < datetime.fromisoformat(times[6])
    x = [float(r["feature"]) for r in training]
    y = [float(r["target"]) for r in training]
    mx, my = sum(x)/len(x), sum(y)/len(y)
    slope = sum((a-mx)*(b-my) for a,b in zip(x,y)) / sum((a-mx)**2 for a in x)
    intercept = my - slope*mx
    predictions = [intercept + slope*float(r["feature"]) for r in evaluation]
    targets = [float(r["target"]) for r in evaluation]
    diagnostics = module(root, "diagnostics").signal(predictions, targets)
    config = json.loads(next((root/"inputs").rglob("check-config.json")).read_text())
    periods, before = [], {r["asset"]: 0.0 for r in evaluation}
    for time in times[6:]:
        indices = [i for i,r in enumerate(evaluation) if r["timestamp"] == time]
        after = {evaluation[i]["asset"]: 0.1 if predictions[i] > 0 else -0.1 for i in indices}
        period = {"period": time, "weightsBefore": dict(before), "weightsAfter": after,
                  "assetReturns": {evaluation[i]["asset"]: targets[i] for i in indices}}
        periods.append(period)
        before = after
    costs = module(root, "cost")
    economics = [costs.economics(period, config["costs"]) for period in periods]
    stress = []
    for multiple in [1, 1.5, 2]:
        adjusted = dict(config["costs"])
        for key in ["commissionBps", "halfSpreadBps", "slippageBps"]:
            adjusted[key] *= multiple
        nets = [costs.economics(period, adjusted)["net"] for period in periods]
        equity = peak = 1.0
        drawdown = 0.0
        for net in nets:
            equity *= 1+net
            peak = max(peak, equity)
            drawdown = max(drawdown, 1-equity/peak)
        stress.append({"multiple": multiple, "netReturn": equity-1, "maxDrawdown": drawdown, "periods": len(nets)})
    data_spec = {"datasetId": "synthetic-100-20261001", "sourceBytes": source,
                 "timezone": "UTC", "timestampColumn": "timestamp", "targetColumn": "target",
                 "firstTimestamp": times[0], "lastTimestamp": times[-1],
                 "roles": {"row_id":"META", "timestamp":"TIMESTAMP", "asset":"ASSET", "feature":"FEATURE", "target":"TARGET"},
                 "dtypes": {name:"string" if name in ["row_id","timestamp","asset"] else "float64" for name in rows[0]},
                 "availability": {name:3600 if name=="target" else 0 for name in rows[0]},
                 "groups": {name:"synthetic" for name in rows[0]}}
    class Frame:
        columns = list(rows[0])
        def __len__(self): return len(rows)
    dataset = module(root, "data").manifest(Frame(), data_spec)
    write(root, "outputs/dataset-manifest.json", dataset)
    write(root, "outputs/diagnostics.json", {"schemaVersion":1, "signal":diagnostics,
        "slices":[], "featureGroupStability":[], "note":"Pooled synthetic evaluation; 4 time periods cannot support robustness claims."})
    write(root, "outputs/portfolio-periods.json", periods)
    stress_report = {"schemaVersion":1, "costMultiples":[1, 1.5, 2],
        "note":"LOCAL_SIMULATION: 40 position contribution rows over 4 correlated time periods; no robustness claim.",
        "scenarios":[{"name":str(s["multiple"])+"x costs", "perturbation":"variable trading costs",
            "magnitude":s["multiple"], "netReturn":s["netReturn"], "maxDrawdown":s["maxDrawdown"],
            "samples":len(evaluation)} for s in stress]}
    write(root, "outputs/economics.json", {"provenance":"LOCAL_SIMULATION", "periods":economics, "stress":stress, "stressReport":stress_report})
    data_spec["sourceBytes"] = list(source)
    write(root, "data.input.json", {"spec":data_spec, "columns":list(rows[0]), "rows":len(rows)})
    write(root, "diagnostics.input.json", {"predictions":predictions, "targets":targets})
    write(root, "portfolio.input.json", {"periods":periods, "contract":config["portfolioContract"]})
    write(root, "cost.input.json", {"periods":periods, "costs":config["costs"]})
    metrics = {"provenance":"LOCAL_SIMULATION", "rows":100, "trainingRows":50, "purgedRows":10,
               "evaluationRows":40, "mae":sum(abs(a-b) for a,b in zip(predictions,targets))/40,
               "rankIC":diagnostics["value"], "model":{"intercept":intercept,"slope":slope},
               "stress":stress, "sourceHash":hashlib.sha256(source).hexdigest(),
               "conclusion":"Synthetic software verification; no real Colab, independent review, or market edge."}
    assert all(math.isfinite(v) for v in [metrics["mae"],metrics["rankIC"],intercept,slope])
    write(root, "simulation-metrics.json", metrics)
    print(json.dumps(metrics))

if __name__ == "__main__":
    root = Path(sys.argv[2]).resolve()
    if sys.argv[1] == "generate": generate(root)
    elif sys.argv[1] == "analyze": analyze(root)
    else: raise SystemExit("expected generate or analyze")
