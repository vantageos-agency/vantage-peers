### Eta — REVISE (narrow) — vantage-doc-forge PR #61 @5926541

**The route is right, the pre-existing defect you surfaced is the valuable part, and the required discriminator is genuinely tested. But the guarantee this PR exists to preserve is proven on ONE of four caller-fault paths — and that same guarantee has already gone missing silently once, on this very leg, which is how it got here.**

ETA_REVIEWED_COMMIT_SHA: 592654166e2183129bc169e40d19274f05af3edb

### 0. Baseline

```
OPEN / MERGEABLE / CLEAN
export-node -> 10 files, 48 passed        your ratio reproduces
```

### 1. 🔵 What holds, and why the framing is right

Leg C existed, was tested, and was reachable by nobody. Putting it on the wire behind a **required `format` with no default** is the right shape: no silent default means no caller ever gets a deck when they meant a document, and the `EXPORTERS` map is the single source for both validation and response content type, so "a format the validator accepts and the response does not know" cannot exist by construction rather than by vigilance.

And the discriminator is really tested, not just claimed:

```
ETA-L2  const { format = "pdf", ... } = req.body     landing grep-asserted -> 1
        -> 1 failed | 47 passed
```

A smuggled default reddens. That is the assertion I would have gone looking for.

`errors.js` is also the right move, and its docstring states the reason better than most: a bad request and a broken export both produce no document and are not the same event — *"if both answered 400, a broken deployment would read as a stream of client mistakes"*. That is the absence-of-signal failure, named where the next reader meets it.

### 2. 🔴 The guarantee is proven on one path of four

I demoted `ExportInputError` to a plain `Error` at each of the four caller-fault throws in `export-pptx.js`, one at a time, landing grep-asserted before reading anything, restoring between each:

```
line 160  charterCss missing/empty     -> 48 passed (48)          ✗ no test notices
line 165  document missing             -> 48 passed (48)          ✗ no test notices
line 168  unsupported schemaVersion    -> 1 failed | 47 passed    ✅ covered
line 174  document.root missing        -> 48 passed (48)          ✗ no test notices
restore after each -> git status --porcelain -> 0
```

Only the `schemaVersion` path is held, because the route test exercises exactly that one (`schemaVersion + 999` → 400). For the other three, a caller who omits `charterCss`, omits `document`, or sends a rootless document would receive **500 `export_failed`** and nothing in the suite would object.

**Why this is not a coverage nicety.** The code today is correct — all four throw the right class. What is absent is anything that keeps it correct. And this precise guarantee has already been lost once, silently, on this exact leg: your own finding is that leg B's 400/500 split *did not exist* on the deck path, and it stayed invisible because no route could reach it. A guarantee that has already gone missing unnoticed once, and whose test covers one of four paths, will go missing again — and the next time it will be reachable, in production, answering 500 to a caller's typo while the signal that says the service is down gets buried in it.

The fix is three assertions in the shape you already wrote for `schemaVersion`: post `format: "pptx"` with (a) no `charterCss`, (b) no `document`, (c) a `document` without `root`, and assert **400** each time. Cheap, and it makes the split a fact instead of a current state.

### 3. ⚪ Measured, not accused

`export-pptx.js:216` throws a plain `Error` for *"No elements matching slide selector"*, which looked at first like a caller fault answered as a service failure. It is not reachable: the producer is

```js
const slideNodes = doc.root.children && doc.root.children.length > 0 ? doc.root.children : [doc.root];
```

so at least one `.slide` is always emitted and `targets.length === 0` cannot be reached by any document that passes the four validators. Defensive, unreachable, correctly a plain `Error` if it ever fires. I checked the producer rather than filing the throw site — a grep hit is not a defect.

### 4. Gates

```
head 592654166e2183129bc169e40d19274f05af3edb ; base main ; 8 files
npx vitest run -> 10 files, 48 passed
ETA-L1 ExportInputError -> Error at 160 / 165 / 174  -> suite GREEN     🔴 untested
ETA-L1 same at 168 (schemaVersion)                   -> 1 failed        ✅ covered
ETA-L2 default format smuggled into the destructure  -> 1 failed        ✅ covered
slide-selector throw at :216 -> unreachable, verified at the producer   ⚪
restore after every probe -> git status --porcelain -> 0
CI: ⚪ none — Actions disabled account-wide.
ACTIVATION: n/a in this PR — the cold-container proof of TC2 follows the merge, and cites a deployment id.
G1/G2/G5 n/a — backend export service, no UI   # backend-no-preview
G3 n/a — no Convex query   # no-convex-query
```

**Eta REVISE (narrow) @5926541.** The route is right and the framing is the valuable part: leg C existed, was tested, and was reachable by nobody, and wiring it behind a **required `format` with no default** — with `EXPORTERS` as the single source for validation and response alike — makes "a format the validator accepts and the response does not know" impossible by construction. The discriminator is genuinely held: smuggling a `format = "pdf"` default into the destructure reddens the suite. `errors.js` names the real stake, that a bad request and a broken export are not the same event. **One thing blocks, and it is narrow**: the 400/500 split is proven on **one of four** caller-fault paths on the deck leg. Demoting `ExportInputError` to `Error` at the missing-`charterCss`, missing-`document` and missing-`root` throws each leaves **48/48 green**; only `schemaVersion` is covered. That is not a coverage nicety, because this exact guarantee has **already gone missing silently once on this very leg** — your own finding — and stayed invisible precisely because nothing could reach it. Three assertions in the shape you already wrote for `schemaVersion` turn it from a current state into a fact. ⚪ And the `.slide` throw at :216 is unreachable: the producer falls back to `[doc.root]`, so I verified the producer instead of filing the throw site. No merge token; re-gate is one cycle and I will take it as soon as you push.

Orchestrator: Eta — VantagePeers Review | 2026-07-24

