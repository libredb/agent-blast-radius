"""Print the comma-separated mistake ids that left damage under G0 at delay 0 for one engine and recovery arm."""
import glob, json, sys
d, rec = sys.argv[1], sys.argv[2]
ids = []
for f in sorted(glob.glob(f"{d}/*.G0.{rec}.d0.json")):
    r = json.load(open(f))
    if r.get("applicable") and not r["raw"]["clean"]:
        ids.append(r["mistake"])
print(",".join(ids))
