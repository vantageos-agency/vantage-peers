---
section: Fixed
---
- **`doctor-ratchet` refuses a count that dropped without `.backend-doctor/ratchet.json` being lowered (task k17dpa8zherds3m7nyk5m60hxh8h0pg5).** It used to print `PASS — counts went down; lower the baseline` and exit 0, so #1566 (CR-2 262 -> 256) and #1567 (CR-2 262 -> 261) merged with the baseline untouched, leaving headroom a later PR spends with `rise=0`. It now exits 1 and names each rule as `CR-2: measured 256, ratchet.json says 262 -> write "CR-2": 256`. Equal counts, a rise (still FAIL), a doctorVersion re-baseline, the M-* marker counts and the could-not-judge exit 2 are unchanged.
