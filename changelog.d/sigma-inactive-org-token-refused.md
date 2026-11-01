---
section: Security
---
- **An access token of an inactive or unmapped organisation no longer resolves.** `oauth:getAccessTokenByHash` answers null (a 401 at the MCP) when the token carries an organisation ID whose mapping is missing or `isActive === false`, instead of a populated context with the org fields dropped; `oauth:rotateRefreshToken` refuses a seat family of such an org (`organisation-inactive`, family revoked, nothing minted). Org-less (fleet) tokens are unchanged. No public args/returns change, no contract bump. Task k17fhnxz9sbqptg0tesxktv7es8hd360.
