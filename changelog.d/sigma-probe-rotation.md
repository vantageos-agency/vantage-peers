---
section: Changed
---
- **Cloud probe tenants: rotation scheduled and expiry recorded (task k175p066gr0jy6wmqp60pp6xkh8h7x9p).** The design note `analysis/durable-scoped-test-identities-2026-10-28.md` section 2 now records the provisioned expiry (2027-01-27, DEV and PROD), the real secret location (0600 files under `/home/elpi/.config/vantage-probe-tenants/`, not Infisical), and the rotation routine `kh7bj9s47c7bv7xtj0g07x061s8h6v5a` that fires 14 days before.
