"""diagnostics.v1 - signal, slice and feature-group stability. Deliberately no economics.

A forecast that is real is not yet a strategy that is profitable, and reporting them in one number is
how the two get confused. This template reports only what can be said about the prediction itself,
and it reports None where a metric is undefined rather than a convenient zero.
"""
import json, sys

SCHEMA_VERSION = 1
TEMPLATE_VERSION = "1.0.0"
MIN_SAMPLES = 30


def signal(predictions, targets, metric="RANK_IC"):
    resolved = [(p, t) for p, t in zip(predictions, targets) if t is not None]
    if len(resolved) < MIN_SAMPLES:
        # Undefined, not zero. An IC over eleven rows is not a small IC; it is not an IC.
        return {"metric": metric, "value": None, "samples": len(resolved), "standardError": None}
    value = rank_ic([p for p, _ in resolved], [t for _, t in resolved])
    return {"metric": metric, "value": value, "samples": len(resolved),
            "standardError": (1.0 - value ** 2) / max(len(resolved) - 2, 1) ** 0.5}


def rank_ic(predictions, targets):
    def ranks(values):
        order = sorted(range(len(values)), key=lambda i: values[i])
        out = [0.0] * len(values)
        for rank, index in enumerate(order):
            out[index] = float(rank)
        return out
    x, y = ranks(predictions), ranks(targets)
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(x, y))
    vx = sum((a - mx) ** 2 for a in x) ** 0.5
    vy = sum((b - my) ** 2 for b in y) ** 0.5
    return cov / (vx * vy) if vx and vy else None


if __name__ == "__main__":
    sys.stdout.write(json.dumps({"template": "diagnostics", "version": TEMPLATE_VERSION}))
