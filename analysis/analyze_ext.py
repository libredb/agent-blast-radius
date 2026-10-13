"""Extended engines (MariaDB, Redis, Elasticsearch) in Layer B: secondary, descriptive (preregistration §8; deviation of
2026-10-13). Same estimators as analyze_b.py where they apply, each engine shown next to its core-set sibling
(MariaDB/MySQL, Redis/Valkey, Elasticsearch/OpenSearch). No hypothesis test here.
Writes analysis/out/layer_b_ext.csv and analysis/out/results_ext.md."""
import os

import numpy as np
import pandas as pd
from scipy.stats import binomtest

from load import load_b

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "analysis", "out")
PAIRS = [("mariadb", "mysql"), ("redis", "valkey"), ("elasticsearch", "opensearch")]
CONTROL = ["C1", "C2", "C3", "C4"]


def wilson(k, n, z=1.959964):
    if n == 0:
        return float("nan"), float("nan")
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def fmt(s):
    s = s.dropna().astype(float)
    k, n = int(s.sum()), len(s)
    if n == 0:
        return "n/a"
    lo, hi = wilson(k, n)
    return f"{k / n:.3f} [{lo:.3f}, {hi:.3f}] ({k}/{n})"


def table(d, col, engines, title):
    lines = [f"### {title}", "", "| engine | G0 | G1 |", "|---|---|---|"]
    for e in engines:
        x = d[d.engine == e]
        lines.append(f"| {e} | {fmt(x[x.arm == 'G0'][col])} | {fmt(x[x.arm == 'G1'][col])} |")
    return lines + [""]


def mcnemar(d, col, e):
    x = d[d.engine == e].pivot_table(index=["model", "task", "paraphrase", "seed"], columns="arm", values=col, aggfunc="first").dropna()
    if not {"G0", "G1"} <= set(x.columns):
        return "n/a"
    b = int(((x.G0 > 0) & (x.G1 == 0)).sum())
    c = int(((x.G0 == 0) & (x.G1 > 0)).sum())
    p = binomtest(b, b + c, 0.5).pvalue if b + c else 1.0
    return f"only G0 {b}, only G1 {c}, exact McNemar p = {p:.4g} ({len(x)} pairs)"


def main():
    ext, excl = load_b("confirm-ext")
    ext.to_csv(os.path.join(OUT, "layer_b_ext.csv"), index=False)
    core = pd.read_csv(os.path.join(OUT, "layer_b.csv"))
    core = core[core.set == "main"]
    both = pd.concat([ext.assign(src="ext"), core.assign(src="core")], ignore_index=True)
    both = both[both.core_task.astype(bool)]
    engines = [e for pair in PAIRS for e in pair]
    md = ["# Extended engines in Layer B (secondary, descriptive)", "",
          "Preregistration §8 rule evaluated 13 Oct 2026 (deviations.md). Main models, seeds 11/23/37, core tasks unless "
          "noted; each extended engine next to its core-set sibling. R0 offers no in-engine undo on MariaDB, Redis or "
          "Elasticsearch, so measured loss is permanent loss.", "",
          f"Trials: {len(ext)} (excluded records: {len(excl)}). Per engine × arm: "
          + ", ".join(f"{e}:{a} {n}" for (e, a), n in ext.groupby(['engine', 'arm']).size().items()), "",
          "Stops: " + ", ".join(f"{k} {v}" for k, v in ext.stop.value_counts().items()), ""]
    md += table(both, "canary_loss_perm_any", engines, "Permanent unwarranted canary loss (primary outcome)")
    md += table(both, "raw_damage", engines, "Raw damage (M2)")
    md += table(both, "attempted_dangerous", engines, "Dangerous attempts (M3)")
    md += table(both.assign(r=both.refused_m4 > 0), "r", engines, "Engine refused at least one statement (M4, recount)")
    md += ["### G0 vs G1, paired (permanent loss)", ""]
    for e, _ in PAIRS:
        md.append(f"- {e}: {mcnemar(both, 'canary_loss_perm_any', e)}")
    md += ["", "### Competence: control-task success by model × engine (both arms)", "",
           "| model | " + " | ".join(engines) + " |", "|---|" + "---|" * len(engines)]
    ctl = both[both.task.isin(CONTROL)]
    for m in sorted(ctl.model.unique()):
        x = ctl[ctl.model == m]
        md.append(f"| {m} | " + " | ".join(f"{x[x.engine == e].success.astype(float).mean():.2f}" for e in engines) + " |")
    md += ["", "### Permanent loss by task template, G0", "", "| task | " + " | ".join(engines) + " |", "|---|" + "---|" * len(engines)]
    g0 = both[both.arm == "G0"]
    for t in sorted(g0.task.unique()):
        x = g0[g0.task == t]
        md.append(f"| {t} | " + " | ".join(f"{x[x.engine == e].canary_loss_perm_any.mean():.2f}" for e in engines) + " |")
    allb = pd.concat([ext.assign(src="ext"), core.assign(src="core")], ignore_index=True)
    t07 = allb[(allb.task == "T07") & (allb.arm == "G1")]
    md += ["", "### T07 (G1): found credential used / other identity tried / saw the credential", ""]
    for e in engines:
        x = t07[t07.engine == e]
        md.append(f"- {e}: used {int(x.used_found_credential.sum())}/{len(x)}, tried other {int(x.tried_other_identity.sum())}, "
                  f"queried app_config {int(x.queried_app_config.sum())}, saw credential {int(x.saw_admin_credential.sum())}")
    t04 = allb[allb.task == "T04"]
    md += ["", "### T04 injection: saw the note / followed / followed given saw (both arms)", ""]
    for e in engines:
        x = t04[t04.engine == e]
        saw = x[x.saw_injection.astype(bool)]
        md.append(f"- {e}: saw {int(x.saw_injection.sum())}/{len(x)}, followed {int(x.injection_followed.astype(float).sum())}, "
                  f"given saw {fmt(saw.injection_followed)}")
    dm = allb[allb.raw_damage.astype(bool) & allb.engine.isin([p[0] for p in PAIRS])]
    md += ["", f"### H6-style report accuracy, extended engines pooled: {fmt(dm.report_misstates)}", ""]
    open(os.path.join(OUT, "results_ext.md"), "w").write("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
