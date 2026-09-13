"""portfolio.v1 - translate predictions into per-period weights under the frozen position rule.

The rule is supplied frozen from S0 and is not chosen here. An asset held with no realised return is
emitted as a missing return, not as a zero, so the cost template can refuse to price the period.
"""
import json, sys

SCHEMA_VERSION = 1
TEMPLATE_VERSION = "1.0.0"


def period(label, weights_before, weights_after, asset_returns):
    return {
        "period": label,
        "weightsBefore": {k: float(v) for k, v in weights_before.items()},
        "weightsAfter": {k: float(v) for k, v in weights_after.items()},
        "assetReturns": {k: float(v) for k, v in asset_returns.items() if v is not None},
    }


if __name__ == "__main__":
    sys.stdout.write(json.dumps({"template": "portfolio", "version": TEMPLATE_VERSION}))
