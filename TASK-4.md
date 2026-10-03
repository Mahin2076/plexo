# Task 4: Relay and assemble

Branch `4` builds on `feat/download-together` to reuse its LAN coordinator and desktop integration.

| ID  | Priority | Action and evidence                                                            | Dependency | Confidence | Status      |
| --- | -------- | ------------------------------------------------------------------------------ | ---------- | ---------- | ----------- |
| 4.1 | P0       | Inspect chunk transport, assembly and lease lifecycle                          | None       | Verified   | Completed   |
| 4.2 | P0       | Add explicit failed-chunk release and bounded helper recovery                  | 4.1        | Plausible  | In progress |
| 4.3 | P0       | Exercise reassignment, stale uploads and exact output hashes in Electron tests | 4.2        | Plausible  | Pending     |
| 4.4 | P1       | Document native phone LAN protocol and delivery boundaries                     | 4.2        | Plausible  | Pending     |
| 4.5 | P0       | Run typecheck, lint, formatting and transfer regression suite                  | 4.3        | Plausible  | Pending     |

Scope: target-side LAN relay and assembly with a native-client-compatible HTTP protocol. A phone app, WebRTC signaling and physical phone/network performance validation are separate integration work. Browser requests remain rejected; a mobile web page cannot select cellular routing while connected to Wi-Fi.

Verification: all 12 `e2e/together.spec.ts` scenarios passed in real Electron instances, including transient helper failure, reassignment ownership, stale upload rejection, abandoned lease expiry and exact final hashes. `npm run typecheck`, `npm run lint`, `npm run format:check` and `git diff --check` passed. Phone participants in protocol tests are simulated HTTP clients; no physical phone or throughput claim is made.

Follow-up requested: use Gemma 4 for the in-app AI model. The AI feature scope is awaiting user clarification; no inference integration is included in this relay change.
