"""Layer A confirmatory analysis (H1-H3; preregistration v1.1 §5, SPEC.md §4). Reads analysis/out/layer_a.csv.

Writes analysis/out/results_a.md and analysis/out/results_a.json.
"""
import json
import os

import pandas as pd
from scipy.stats import binomtest
from statsmodels.stats.multitest import multipletests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "analysis", "out")
ENGINES = ["postgres", "mysql", "mariadb", "sqlite"]


def md_table(df: pd.DataFrame) -> str:
    cols = [str(c) for c in df.columns]
    lines = ["| " + " | ".join([df.index.name or ""] + cols) + " |", "|" + "---|" * (len(cols) + 1)]
    for i, r in df.iterrows():
        lines.append("| " + " | ".join([str(i)] + [str(v) for v in r.values]) + " |")
    return "\n".join(lines)


def mcnemar(b01, b10):
    n = b01 + b10
    return 1.0 if n == 0 else binomtest(b01, n, 0.5).pvalue


def cells(a, perm, rec, delay=0):
    d = a[(a.perm == perm) & (a.rec == rec) & (a.delay_ms == delay)]
    return d.set_index(["engine", "mistake"])


def h1(a):
    g = cells(a, "G0", "R0")
    g = g[g.applicable]
    per = g.groupby("mistake").agg(engines=("perm_loss", "size"), with_loss=("perm_loss", "sum"))
    per = per[per.engines >= 2]
    per["differs"] = (per.with_loss > 0) & (per.with_loss < per.engines)
    share = per.differs.mean()
    matrix = g.perm_loss.unstack("engine").reindex(columns=ENGINES).map(
        lambda v: "n/a" if pd.isna(v) else ("LOSS" if v else "-"))
    return {"mistakes": int(len(per)), "differing": int(per.differs.sum()), "share": round(float(share), 4),
            "threshold": 0.30, "verdict": "supported" if share >= 0.30 else "not supported",
            "differing_ids": per.index[per.differs].tolist()}, matrix


def h2(a):
    base = cells(a, "G0", "R0")
    base = base[base.applicable & base.perm_loss]
    g1 = cells(a, "G1", "R0")
    g2s = cells(a, "G2s", "R0")
    g2n = cells(a, "G2n", "R0")
    g12 = cells(a, "G1G2s", "R0")
    rows = []
    for idx, r in base.iterrows():
        if idx not in g1.index or not g1.loc[idx].applicable:
            continue  # G1 not applicable (SQLite): out of both arms, SPEC §4
        rows.append({"engine": idx[0], "mistake": idx[1], "class": r["class"],
                     "G1": not g1.loc[idx].perm_loss, "G2s": not g2s.loc[idx].perm_loss,
                     "G2n": not g2n.loc[idx].perm_loss, "G1G2s": not g12.loc[idx].perm_loss})
    d = pd.DataFrame(rows)
    out = []
    for c, g in d.groupby("class"):
        b01 = int((~g.G1 & g.G2s).sum())  # G2s prevents, G1 does not
        b10 = int((g.G1 & ~g.G2s).sum())
        diff = g.G1.mean() - g.G2s.mean()
        out.append({"class": c, "cells": len(g), "G1 prevented": round(g.G1.mean(), 3), "G2s prevented": round(g.G2s.mean(), 3),
                    "G2n prevented": round(g.G2n.mean(), 3), "G1+G2s prevented": round(g.G1G2s.mean(), 3),
                    "diff G1-G2s": round(diff, 3), "rule (>=0.20)": "supported" if diff >= 0.20 else "not supported",
                    "only G1": b10, "only G2s": b01, "p": mcnemar(b01, b10)})
    r = pd.DataFrame(out)
    r["p_holm"] = multipletests(r.p, method="holm")[1].round(4)
    r["p"] = r.p.round(4)
    return r.set_index("class"), d


def g1_cost_a(a):
    """Layer A has no legitimate-operation cells; G1 cost is measured in Layer B (M9). Report refusals of G1 here."""
    g = a[(a.perm == "G1") & (a.rec == "R0") & (a.delay_ms == 0) & a.applicable]
    return g.groupby("engine").refused.mean().round(3)


def h3(a):
    r0 = cells(a, "G0", "R0")
    r1 = cells(a, "G0", "R1")
    rows = []
    for e in ENGINES:
        x0 = r0.loc[e][r0.loc[e].applicable]
        x1 = r1.loc[e].reindex(x0.index)
        loss0, loss1 = x0.perm_loss.astype(bool), x1.perm_loss.astype(bool)
        b10 = int((loss0 & ~loss1).sum())  # R1 prevents
        b01 = int((~loss0 & loss1).sum())
        rows.append({"engine": e, "mistakes": len(x0), "perm loss R0": int(loss0.sum()), "perm loss R1": int(loss1.sum()),
                     "R1 recovers": b10, "R1 worse": b01, "p": mcnemar(b01, b10), "reduces": int(loss1.sum()) < int(loss0.sum())})
    r = pd.DataFrame(rows)
    r["p_holm"] = multipletests(r.p, method="holm")[1].round(4)
    r["p"] = r.p.round(4)
    first = r.reduces.sum() >= len(ENGINES) / 2

    # Delay: recoverable share among cells damaged before recovery, delay 0 vs 10 minutes.
    dl = []
    for rec in ["R0", "R1"]:
        for e in ENGINES:
            sh = {}
            for delay in [0, 600000]:
                c = a[(a.engine == e) & (a.perm == "G0") & (a.rec == rec) & (a.delay_ms == delay) & a.applicable & ~a.raw_clean]
                sh[delay] = (c.perm_clean.mean() if len(c) else float("nan"), len(c))
            # Same mistakes at both delays (the 10-min drill ran only where G0 damage occurred).
            m10 = a[(a.engine == e) & (a.perm == "G0") & (a.rec == rec) & (a.delay_ms == 600000)].mistake
            c0 = a[(a.engine == e) & (a.perm == "G0") & (a.rec == rec) & (a.delay_ms == 0) & a.mistake.isin(m10) & ~a.raw_clean]
            c10 = a[(a.engine == e) & (a.perm == "G0") & (a.rec == rec) & (a.delay_ms == 600000) & a.mistake.isin(c0.mistake) & ~a.raw_clean]
            s0 = c0.perm_clean.mean() if len(c0) else float("nan")
            s10 = c10.perm_clean.mean() if len(c10) else float("nan")
            dl.append({"rec": rec, "engine": e, "damaged d0": len(c0), "recoverable d0": round(s0, 3),
                       "damaged d10m": len(c10), "recoverable d10m": round(s10, 3),
                       "non-increasing": bool(not (s10 > s0 + 1e-9))})
    dl = pd.DataFrame(dl)
    second = dl["non-increasing"].all()
    verdict = "supported" if (first and second) else "not supported"
    return r.set_index("engine"), dl.set_index(["rec", "engine"]), {"engines_reduced": int(r.reduces.sum()), "of": len(ENGINES),
                                                                   "part1": bool(first), "part2": bool(second), "verdict": verdict}


def main():
    a = pd.read_csv(os.path.join(OUT, "layer_a.csv"))
    res = {}
    md = ["# Layer A results (confirmatory, four relational engines)", "",
          f"Cells: {len(a)} ({int((~a.applicable).sum())} not applicable). Permanent loss = canaries still lost after the drill.", ""]
    r, matrix = h1(a)
    res["H1"] = r
    md += ["## H1: same mistake, different permanent loss across engines (G0/R0, delay 0)", "",
           f"{r['differing']}/{r['mistakes']} mistakes differ = {r['share']} (threshold ≥ 0.30) → **{r['verdict']}**. "
           f"Differing: {', '.join(r['differing_ids'])}.", "", md_table(matrix), ""]
    raw = cells(a, "G0", "R0")
    rawm = raw[raw.applicable].raw_loss.unstack("engine").reindex(columns=ENGINES).map(lambda v: "n/a" if pd.isna(v) else ("loss" if v else "-"))
    md += ["Raw loss before the R0 drill (for mechanism reading):", "", md_table(rawm), ""]

    t, d = h2(a)
    res["H2"] = t.reset_index().to_dict(orient="records")
    md += ["## H2: G1 vs G2-strong per damage class (cells with permanent loss under G0/R0; SQLite out, no G1)", "",
           md_table(t), "", "Cell-level detail:", "", md_table(d.set_index(["engine", "mistake"])), "",
           "G1 refusal share per engine (applicable G1/R0 cells):", "", md_table(g1_cost_a(a).to_frame("refused")), ""]

    t3, dl, v = h3(a)
    res["H3"] = {"per_engine": t3.reset_index().to_dict(orient="records"), "delay": dl.reset_index().to_dict(orient="records"), **v}
    md += ["## H3: recovery setup (R1 vs R0) and detection delay", "",
           f"Engines where R1 reduces permanent loss: {v['engines_reduced']}/{v['of']} (part 1 {'met' if v['part1'] else 'not met'}); "
           f"recoverable share non-increasing with delay on every engine: {'yes' if v['part2'] else 'no'} → **{v['verdict']}**.", "",
           md_table(t3), "", md_table(dl), "",
           "30-minute and 24-hour drills: none of the four relational engines has a time-dependent recovery mechanism in the "
           "tested setups, so they are documented as delay-invariant (preregistration §3).", ""]
    with open(os.path.join(OUT, "results_a.md"), "w") as fh:
        fh.write("\n".join(md) + "\n")
    with open(os.path.join(OUT, "results_a.json"), "w") as fh:
        json.dump(res, fh, indent=1, default=str)
    print("H1", res["H1"]["share"], res["H1"]["verdict"])
    print(t[["cells", "G1 prevented", "G2s prevented", "diff G1-G2s", "rule (>=0.20)", "p_holm"]].to_string())
    print("H3", v)


if __name__ == "__main__":
    main()
