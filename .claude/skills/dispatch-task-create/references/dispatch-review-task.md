# Example — Dispatch a review task to eta with dependency

```
User: ask eta to review the v2.4.2 release once sigma's task k7abc is done

pi: <runs dispatch-task-create>
  - title: "Review mcp-server v2.4.2 release artifacts"
  - assignedTo=eta, priority=high, createdBy=pi
  - dependsOn=["k7abc...xyz"]
  - VERIFICATION:
      1. checkout HEAD SHA cited in PR description
      2. run npm test
      3. inspect package.json version bump
  - TESTS: APPROVED verdict citing commit SHA + 311/314 test ratio
  - IRP: Input PR #N / Result [ETA-APPROVED] completion note /
         Postcondition npm publish hook unblocked

Output:
  Task k9def...uvw dispatched to eta (blocked on k7abc...xyz).
  Next: dispatch-message eta with [INFO ONLY] review queued behind task k7abc.
```
