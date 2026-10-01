---
section: Fixed
---
messages:getUnreadCount answers a refused caller (signed in without an organisation, or asking for an orchestrator outside its roster) with { refused: true, count: 0 } instead of a bare 0; a served member with nothing unread still gets 0.
