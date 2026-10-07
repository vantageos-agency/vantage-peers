---
section: Changed
---
- **Owner-binding reads say when they are capped.** `githubOwnerBinding:listBindings` and `listUnprovenMappings` replace a bare `.take(500)`/`.take(2000)` with the named caps `OWNER_BINDING_LIST_CAP` and `UNPROVEN_MAPPING_SCAN_CAP` and return `{ items, truncated }`; `get_github_owner_bindings` reports `bindingsTruncated` and `unprovenMappingsTruncated`. Both reads are new in this release, so no released caller reads the old array shape.
