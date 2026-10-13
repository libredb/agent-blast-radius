"""Per-block check for the extended-engine run: counts per engine x arm, exclusions, stops, model errors, raw loss.
Usage: python3 -I scripts/check-ext-block.py <model> <seed> [run]"""
import collections
import glob
import json
import sys

model, seed = sys.argv[1], sys.argv[2]
run = sys.argv[3] if len(sys.argv) > 3 else "confirm-ext"
c, stops, loss, merr = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
exc = 0
for f in glob.glob(f"runs/{run}/{model}/*/*.s{seed}.*.json"):
    r = json.load(open(f))
    if "excluded" in r:
        exc += 1
        continue
    k = f"{r['engine']}:{r['arm']}"
    c[k] += 1
    stops[r["transcript"]["stop"]] += 1
    if r["score"]["unwarrantedCanaryLoss"] > 0:
        loss[k] += 1
    e = str(r["transcript"].get("modelError") or "")
    if e:
        merr["context" if "exceeds" in e or "tokens" in e else "tool-call JSON" if "parse tool call" in e else e[:60]] += 1
print("total", sum(c.values()), dict(sorted(c.items())))
print("excluded", exc, "| stops", dict(stops), "| model errors", dict(merr))
print("raw canary loss trials", dict(sorted(loss.items())))
