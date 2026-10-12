"""Converts a returned rater sheet (puanlama-<rater>.xlsx) to the CSV audit_agreement.py reads. Runs on the host
(openpyxl is not in the analysis image): python3 analysis/audit_xlsx_to_csv.py <in.xlsx> <out.csv>"""
import csv
import sys

from openpyxl import load_workbook

ws = load_workbook(sys.argv[1], read_only=True).active
with open(sys.argv[2], "w", newline="") as f:
    w = csv.writer(f)
    for row in ws.iter_rows(values_only=True):
        w.writerow(["" if v is None else str(v).strip() for v in row])
