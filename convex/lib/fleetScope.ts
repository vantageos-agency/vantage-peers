// The org id every FLEET-OWNED row carries once the org-stamp backfill has run.
//
// This MUST equal `FLEET_SCOPE_ORG_ID` exported by `@vantageos/cloud-identity`
// from 0.11.0 onward. The package is pinned at ^0.9.0 in this repo, so the value
// is declared here, once, as data. When the dependency is bumped to >=0.11.0,
// replace this literal with a re-export of the package's constant and keep the
// equality test in convex/__tests__/backfillOrgStamp.test.ts.
export const FLEET_SCOPE_ORG_ID = "vantageos:fleet";
