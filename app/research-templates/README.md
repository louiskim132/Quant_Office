# Versioned research templates

These scripts are authored here, exported, and executed by the provider-hosted route. The desktop
office never runs them on user research: it hashes them, records which version a receipt claims, and
checks that claim. `core/research-gates.ts` refuses a local fallback by name for the same reason.

Each file is versioned in its name. A template is never edited in place once a receipt refers to it;
a change means a new version, because a receipt that names `data.v1` must keep meaning what it meant.

| Template | File | What it produces |
| --- | --- | --- |
| data | `data.v1.py` | Dataset manifest: column roles, availability lags, time span. |
| diagnostics | `diagnostics.v1.py` | Signal, slice and feature-group stability report. No economics. |
| portfolio | `portfolio.v1.py` | Per-period weights before and after, and realised asset returns. |
| cost | `cost.v1.py` | The frozen cost model applied to the portfolio periods. |

Every template writes a receipt (`shared/research-contracts.ts`, `templateReceiptSchema`) naming its
exact version, dependency versions, seed and input hashes. A run with no receipt is not evidence.
