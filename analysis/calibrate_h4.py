"""H4 calibration (post-hoc, descriptive, not preregistered; added 2026-10-30 after an outside methods review).

H4 compares the range of attempted-damage rates over nine engines (432 trials each) with the range over four models
(972 trials each). A range over nine groups is larger than a range over four drawn from the same distribution, and a
432-trial rate is noisier than a 972-trial one, so the ratio is above 1 even when engines and models differ equally.
This script simulates the ratio under that null to show where the observed 4.1 falls.

Null model (exactly what is simulated):
  logit p(engine e, model m) = mu + a_e + b_m,  a_1..a_9 ~ iid N(0, sigma^2),  b_1..b_4 ~ iid N(0, sigma^2)
  (the SAME sigma for engines and models: equal true spread), mu = logit of the observed pooled rate.
  Each of the 36 engine x model cells gets 108 trials (36 task instances x 3 seeds), as in the G0 core main-set data.
  Variant "independent": the 108 trials are independent Bernoulli(p).
  Variant "seed-locked": 36 Bernoulli(p) draws, each counted three times (outcome identical over the three seeds,
  the extreme of the 94-96% repeat agreement seen in the data); this adds noise, so it is the less favourable null.
  Rates and ranges are then computed exactly as analyze_b.spread_ratio does (pooled over trials of the engine/model).
  Not simulated: task-instance effects (balanced across engines and models, so on the probability scale they cancel
  in both ranges) and engine x model interaction.
  sigma grid: 0 (no true differences), the observed logit SD of the four model rates, the observed logit SD of all
  thirteen group rates pooled (the headline null: equal spread set from the data), and the observed logit SD of the
  nine engine rates. For the headline sigma the effects are also drawn uniform (same SD) instead of normal, since
  the tail of a range ratio depends on how often four draws land close together. 10,000 simulations per setting,
  seed 20261012.

Run: ./analysis/run.sh calibrate_h4.py  (also imported by sensitivity_b.py).
"""
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "analysis", "out")
SEED = 20261012
N_SIM = 10000
MAIN = ["qwen3.5-9b", "granite4.1-8b", "ministral-3-8b", "gemma4-12b"]
CORE = ["C1", "C2", "C3", "C4", "T01", "T02", "T04", "T05", "T06", "T08", "T09", "T10"]


def logit(p):
    return np.log(p / (1 - p))


def observed(b):
    d = b[(b.arm == "G0") & b.task.isin(CORE) & b.model.isin(MAIN)]
    y = d.attempted_dangerous.astype(bool)
    e = y.groupby(d.engine).mean()
    m = y.groupby(d.model).mean()
    cell = d.groupby(["engine", "model"]).size()
    return {"engine_rates": e, "model_rates": m, "pooled": float(y.mean()), "n": len(d),
            "cell_n": sorted(set(cell.tolist())), "ratio": float((e.max() - e.min()) / (m.max() - m.min()))}


def simulate(mu, sigma, n_eng=9, n_mod=4, per_cell=108, seeds=3, locked=False, dist="normal", n_sim=N_SIM, seed=SEED):
    rng = np.random.default_rng(seed)
    if dist == "normal":
        a = rng.normal(0, sigma, (n_sim, n_eng, 1))
        bm = rng.normal(0, sigma, (n_sim, 1, n_mod))
    else:  # uniform with the same SD: half-width sigma * sqrt(3)
        h = sigma * np.sqrt(3)
        a = rng.uniform(-h, h, (n_sim, n_eng, 1))
        bm = rng.uniform(-h, h, (n_sim, 1, n_mod))
    p = 1 / (1 + np.exp(-(mu + a + bm)))
    k = rng.binomial(per_cell // seeds, p) * seeds if locked else rng.binomial(per_cell, p)
    er = k.sum(axis=2) / (per_cell * n_mod)
    mr = k.sum(axis=1) / (per_cell * n_eng)
    es = er.max(axis=1) - er.min(axis=1)
    ms = mr.max(axis=1) - mr.min(axis=1)
    with np.errstate(divide="ignore"):
        return np.where(ms > 0, es / np.where(ms > 0, ms, 1), np.inf)


def calibrate(b):
    o = observed(b)
    mu = float(logit(o["pooled"]))
    sd_m = float(np.std(logit(o["model_rates"].values), ddof=1))
    sd_e = float(np.std(logit(o["engine_rates"].values), ddof=1))
    sd_all = float(np.std(logit(np.concatenate([o["engine_rates"].values, o["model_rates"].values])), ddof=1))
    grid = [("0 (no true differences)", 0.0), ("model logit SD", sd_m), ("pooled logit SD, all 13 groups (headline)", sd_all),
            ("engine logit SD", sd_e)]
    rows = []
    settings = [(lab, sg, lk, "normal") for lab, sg in grid for lk in (False, True)]
    settings += [(grid[2][0], sd_all, lk, "uniform") for lk in (False, True)]
    for label, s, locked, dist in settings:
        r = simulate(mu, s, locked=locked, dist=dist)
        lo, med, hi = np.percentile(np.where(np.isfinite(r), r, 1e9), [2.5, 50, 97.5])
        rows.append({"sigma": f"{label} = {s:.3f}", "effects": dist, "variant": "seed-locked" if locked else "independent",
                     "median": round(float(med), 2), "95% range": f"{lo:.2f} to {hi:.2f}",
                     "P(ratio >= obs)": round(float((r >= o["ratio"]).mean()), 4)})
    return o, {"mu": mu, "sd_model": sd_m, "sd_engine": sd_e, "sd_all": sd_all}, pd.DataFrame(rows)


if __name__ == "__main__":
    b = pd.read_csv(os.path.join(OUT, "layer_b.csv"))
    o, s, t = calibrate(b)
    print(f"observed ratio {o['ratio']:.3f}, n={o['n']}, cell sizes {o['cell_n']}, pooled {o['pooled']:.4f}, {s}")
    print(t.to_string(index=False))
