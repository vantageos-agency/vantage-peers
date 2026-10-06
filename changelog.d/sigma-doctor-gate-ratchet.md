---
section: Changed
---
- **The backend-doctor deploy gate ratchets against a committed baseline (RULING 6, task k172fnxzt4f71yj801mqjcdgnx8fr0md).** `.claude/config/backend-doctor-baseline.json` holds per-rule ceilings measured with backend-doctor@1bda92f (R-2 6, R-8 2, R-13 108, R-28 7, R-31 18 on 65e517e; R-52 4, R-53 113 on e85618d), each with its command and doctor output line. `enforce-backend-doctor-before-deploy.py` v1.3.0 refuses a red tree when a rule is above its ceiling, a red rule is not baselined, a closed module lane carries a site, or the baseline rises against `origin/main`. Evidence without `mechanical_rule_counts` still refuses: backend-doctor@1bda92f does not emit that field yet.
