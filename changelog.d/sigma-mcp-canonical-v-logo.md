---
section: Fixed
---
- **Cloud: the MCP origin serves the canonical VantagePeers "V" logo, not the site's placeholders (task k17455xv7tzgdqr6ys861pd38h8habp5).** #1611 copied www.vantagepeers.com's three icon files, but the site's `favicon.ico` was the default Next.js triangle and its `apple-touch-icon.png` a placeholder purple circle (what Google's favicon service, and so Claude, showed). All three are now rendered from the brand source `vantageos-agency/vantage-peers-site public/logo-v.svg` (white V on black): favicon.ico (16/32/48/256, sha256 e7a9c186…), icon.png (256, 5f4b2a8a…), apple-touch-icon.png (180, ac6a3a79…), byte-identical to the site's own fix (vantage-peers-site PR). `favicon.test.ts` pins the three sha256. No Convex change, contract unchanged.
