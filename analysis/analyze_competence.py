"""Secondary analysis named in the preregistration (§6): outcomes conditional on model × engine competence.

Competence of a model × engine cell = task success on the control tasks C1-C4, both arms (the measure the
preregistration names). The cut-off is not preregistered; 0.5 is used and 0.75 reported as a sensitivity, both
chosen after the first outcome tables and labelled so in the report. Main models, core tasks.
Writes analysis/out/results_competence.md.
"""
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "analysis", "out")
MAIN = ["qwen3.5-9b", "granite4.1-8b", "ministral-3-8b", "gemma4-12b"]
CONTROL = ["C1", "C2", "C3", "C4"]
SEED = 20261012
B = 10000


def wilson(k, n, z=1.959964):
    if n == 0:
        return float("nan"), float("nan")
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def fmt(k, n):
    if n == 0:
        return "n/a"
    lo, hi = wilson(k, n)
    return f"{k / n:.3f} [{lo:.3f}, {hi:.3f}] ({int(k)}/{n})"


def spread_ratio(d, outcome, rng):
    """H4-style ratio (engine spread / model spread) with the H4 bootstrap over task instances."""
    def ratio(x):
        e = x.groupby("engine")[outcome].mean()
        m = x.groupby("model")[outcome].mean()
        ms = m.max() - m.min()
        return (e.max() - e.min()) / ms if ms > 0 else np.inf
    point = ratio(d)
    inst = d.instance.unique()
    groups = {i: g for i, g in d.groupby("instance")}
    boots = []
    for _ in range(B):
        pick = rng.choice(inst, size=len(inst), replace=True)
        boots.append(ratio(pd.concat([groups[i] for i in pick])))
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return point, lo, hi


def main():
    b = pd.read_csv(os.path.join(OUT, "layer_b.csv"))
    b = b[b.model.isin(MAIN) & b.core_task.astype(bool)].copy()
    comp = b[b.task.isin(CONTROL)].groupby(["model", "engine"]).success.mean().rename("competence")
    b = b.join(comp, on=["model", "engine"])
    hz = b[~b.task.isin(CONTROL)].copy()
    lines = ["# Competence-conditional outcomes (secondary, preregistration §6)", "",
             "Competence = control-task (C1-C4) success of the model × engine cell, both arms. Main models, core tasks; "
             "outcomes on the hazard templates only (control tasks define competence and are left out). "
             "Cut-offs 0.5 and 0.75 chosen after the first outcome tables (not preregistered).", "",
             "## Competence per model × engine (main models)", "",
             "| model | " + " | ".join(sorted(b.engine.unique())) + " |", "|---|" + "---|" * b.engine.nunique()]
    for m in MAIN:
        lines.append(f"| {m} | " + " | ".join(f"{comp.get((m, e), float('nan')):.2f}" for e in sorted(b.engine.unique())) + " |")
    for cut in (0.5, 0.75):
        lines += ["", f"## Hazard templates, G0: competent cells (competence ≥ {cut}) vs the rest", "",
                  "| engine | competent cells | permanent loss, competent | permanent loss, rest | attempted, competent | attempted, rest |",
                  "|---|---|---|---|---|---|"]
        g0 = hz[hz.arm == "G0"]
        for e in sorted(g0.engine.unique()):
            x = g0[g0.engine == e]
            c, r = x[x.competence >= cut], x[x.competence < cut]
            cl = c.canary_loss_perm_any.dropna()
            rl = r.canary_loss_perm_any.dropna()
            lines.append(f"| {e} | {c.model.nunique()}/4 | {fmt(cl.sum(), len(cl))} | {fmt(rl.sum(), len(rl))} | "
                         f"{fmt(c.attempted_dangerous.sum(), len(c))} | {fmt(r.attempted_dangerous.sum(), len(r))} |")
        allc = g0[g0.competence >= cut].canary_loss_perm_any.dropna()
        allr = g0[g0.competence < cut].canary_loss_perm_any.dropna()
        lines += ["", f"All engines, G0 hazard templates: permanent loss competent {fmt(allc.sum(), len(allc))}, "
                      f"rest {fmt(allr.sum(), len(allr))}."]
    # Engine comparison restricted to engines where every main model is competent (≥ 0.5).
    full = [e for e in sorted(b.engine.unique()) if all(comp.get((m, e), 0) >= 0.5 for m in MAIN)]
    rng = np.random.default_rng(SEED)
    d = b[(b.arm == "G0") & b.engine.isin(full)].dropna(subset=["canary_loss_perm_any"])
    lines += ["", "## Engines where all four main models are competent (≥ 0.5)", "",
              f"Engines: {', '.join(full)}.", ""]
    for outcome in ("attempted_dangerous", "canary_loss_perm_any"):
        p, lo, hi = spread_ratio(d, outcome, rng)
        lines.append(f"- {outcome}, G0, core tasks: engine/model spread ratio {p:.3f}, bootstrap 95% CI [{lo:.3f}, {hi:.3f}] "
                     f"(H4 estimator on this subset; descriptive)")
    lines += ["", "| engine | G0 permanent loss | G1 permanent loss |", "|---|---|---|"]
    for e in full:
        x = b[b.engine == e]
        cells = []
        for arm in ("G0", "G1"):
            y = x[x.arm == arm].canary_loss_perm_any.dropna()
            cells.append(fmt(y.sum(), len(y)))
        lines.append(f"| {e} | {cells[0]} | {cells[1]} |")
    open(os.path.join(OUT, "results_competence.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
