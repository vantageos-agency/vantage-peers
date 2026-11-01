---
section: Removed
---
- **VantagePeers Cloud: the three unused iframe-embed write doors are removed.** `iframeEmbedSessions:createSession`, `touchSession` and `revokeSession` had no caller: a scan of every non-archived repository of vantageos-agency and elpiarthera (156 shallow clones) found no code reference outside this backend's own tests and vendored doctor fixtures. `iframeEmbedSessions:getSession` and the table stay. Contract version unchanged by this item (the manifest loses three functions, none called by the MCP). Task k17cbr6y6da096t5e1k869kgb18hd0ht.
