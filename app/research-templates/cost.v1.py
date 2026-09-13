"""cost.v1 - the frozen cost model, applied exactly as core/research-gates.ts applies it.

gross     = sum(weight_after * asset_return)
turnover  = sum(|weight_after - weight_before|)
cost      = turnover * (commission + half_spread + slippage) / 10_000
          + short_exposure * borrow / 10_000
          + gross_exposure * financing / 10_000
net       = gross - cost

The two implementations are kept deliberately identical so a hand-computed fixture checks both.
"""
import json, sys

SCHEMA_VERSION = 1
TEMPLATE_VERSION = "1.0.0"


def economics(period, costs):
    assets = set(period["weightsBefore"]) | set(period["weightsAfter"])
    unpriced = sorted(a for a in assets
                      if period["weightsAfter"].get(a, 0.0) != 0.0 and a not in period["assetReturns"])
    if unpriced:
        return {"unpriced": unpriced}
    gross = turnover = short_exposure = gross_exposure = 0.0
    for asset in assets:
        before = period["weightsBefore"].get(asset, 0.0)
        after = period["weightsAfter"].get(asset, 0.0)
        gross += after * period["assetReturns"].get(asset, 0.0)
        turnover += abs(after - before)
        if after < 0:
            short_exposure += abs(after)
        gross_exposure += abs(after)
    trading = turnover * (costs["commissionBps"] + costs["halfSpreadBps"] + costs["slippageBps"]) / 10_000
    carry = (short_exposure * costs["borrowBpsPerPeriod"] / 10_000
             + gross_exposure * costs["financingBpsPerPeriod"] / 10_000)
    return {"period": period["period"], "gross": gross, "turnover": turnover,
            "cost": trading + carry, "net": gross - trading - carry}


if __name__ == "__main__":
    sys.stdout.write(json.dumps({"template": "cost", "version": TEMPLATE_VERSION}))
