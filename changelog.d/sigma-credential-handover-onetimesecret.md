---
section: Added
---
- **Runbook: handing a credential to a person (Cloud; task k17ch9a2xg1wdxt04g4v0zregx8hdpdc).** `runbooks/onboard-client-org.md` section "Handing a credential to a person" (merged in #1641, 10c713e8): every password, client secret or other credential travels through https://eu.onetimesecret.com/ only, with a passphrase and the shortest expiry; the link and the passphrase go on two different channels; the task records the handover (channels, expiry), never the secret, link or passphrase; an opened or expired link means the credential is rotated. Fragment added after the merge, on Eta's correction to #1641.
