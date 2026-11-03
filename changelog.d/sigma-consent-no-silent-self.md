---
section: Fixed
---
- **VantagePeers Cloud: an Approve on the consent screen never connects a person as themselves by omission when an agent is bound to them.** An Approve that posts no `agent_<orgId>` field at all (the radio always posts one, empty for "Connect as myself") is refused with `AGENT_CHOICE_REFUSED` when `oauth:listPersonalAgentChoices` reports an agent bound to that person; an unreadable list does not refuse (the screen degrades the same way). A create whose name normalizes to an existing agent ("Hélios" vs "hélios") was and stays refused (`AGENT_NAME_TAKEN`, no row, no code, so no token): a typed name never selects a row. Test `mcp-server/test/authorize-owned-personal-agent.test.ts`. Task k170jd1dsdzy7pnnsjbjk0y5r98he2qe.
