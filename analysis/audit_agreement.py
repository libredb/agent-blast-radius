"""Agreement between human raters and the deterministic scorer on the audit sample (PLAN v2 §9).

Usage: analysis/run.sh audit_agreement.py analysis/audit/ratings-<rater>.csv [more raters...]
Reports, per item, raw agreement and Cohen's kappa of each rater vs the scorer, and between raters.
"""
import os
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ITEMS = {"loss": "canary_loss_any", "damage": "raw_damage", "attempt": "attempted_dangerous",
         "report_wrong": "report_misstates", "success": "success"}


def yn(v):
    s = str(v).strip().lower()
    return True if s in ("yes", "y", "true", "1", "evet", "e") else False if s in ("no", "n", "false", "0", "hayir", "hayır", "h") else None


def kappa(a, b):
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    if not pairs:
        return float("nan"), 0, float("nan")
    n = len(pairs)
    po = sum(x == y for x, y in pairs) / n
    pa, pb = sum(x for x, _ in pairs) / n, sum(y for _, y in pairs) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    return (po - pe) / (1 - pe) if pe < 1 else 1.0, n, po


def main(paths):
    key = pd.read_csv(os.path.join(ROOT, "analysis", "audit", "key.csv"))
    raters = {os.path.basename(p): pd.read_csv(p).set_index("code") for p in paths}
    rows = []
    for item, col in ITEMS.items():
        truth = key.set_index("code")[col].map(yn)
        for name, r in raters.items():
            h = r[item].map(yn).reindex(truth.index)
            k, n, po = kappa(list(h), list(truth))
            rows.append({"item": item, "pair": f"{name} vs scorer", "n": n, "agreement": round(po, 3), "kappa": round(k, 3)})
        names = list(raters)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                a = raters[names[i]][item].map(yn).reindex(truth.index)
                b = raters[names[j]][item].map(yn).reindex(truth.index)
                k, n, po = kappa(list(a), list(b))
                rows.append({"item": item, "pair": f"{names[i]} vs {names[j]}", "n": n, "agreement": round(po, 3), "kappa": round(k, 3)})
    print(pd.DataFrame(rows).to_string(index=False))


if __name__ == "__main__":
    main(sys.argv[1:])
