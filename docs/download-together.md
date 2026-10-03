# Download Together (preview)

Two or more Plexo computers can fetch different pieces of one file through their own internet connections. Helpers send their pieces over a shared local network; the host saves the complete file.

## Try it

1. Run the same version of Plexo on both computers (`npm ci`, then `npm run dev`).
2. Connect both computers to a trusted local network. For a speed benefit, give the helper a separate internet connection, such as a USB-tethered phone. Both computers on one home broadband connection usually share the same bottleneck.
3. On the host, open **Download Together → Host**. Choose the internet connection to fetch pieces and the local IPv4 address reachable by your friend. These can be different connections. Enter a public file URL and destination folder. If the publisher supplies a SHA-256 checksum, paste it.
4. Click **Create session** and share the full `plexo://…` join code privately. Allow incoming Plexo connections if your OS firewall prompts you. Guest Wi-Fi/client isolation may prevent computers from reaching each other; no port forwarding is needed.
5. On the helper, open **Download Together → Join**, paste the code and click **Review file**. Check the source URL, choose the internet connection, enter a name and a maximum source-data allowance in MiB, then click **Join and help**.
6. On the host, click **Start together**. The progress card shows each computer's contribution. The helper may leave at any time. The host reclaims incomplete pieces immediately on a clean leave, or within 45 seconds after an abrupt disconnect.
7. The host checks and publishes the completed file. Click **Show file** to open its folder. Helpers do not retain a complete copy.

The data allowance counts received file payload, including unsuccessful attempts. TCP/TLS and other protocol overhead are extra, and sending the pieces to the host also uses the local network. Plexo stops assigning full pieces when the remaining allowance is insufficient; this is not an OS-level cellular billing cap.

## Requirements and boundaries

- The link must support HTTP byte ranges, report a size, and supply a strong ETag. Together validates the exact ETag, Content-Range and byte count for every response. A changed source, missing validator or mid-transfer redirect is rejected. The regular download mode supports a broader set of servers.
- Public HTTP(S) files only: no browser cookies, account login, URL credentials or DRM support. Do not use sensitive/signed links: everyone with the join code sees the source URL.
- IPv4 local pairing, one Together session per app, up to four helper registrations per session, and one in-flight 1 MiB piece per participant. Source files are limited to 100,000 pieces (about 97.7 GiB).
- Use trusted helpers on a trusted network. The random join token restricts access, but LAN pairing and payloads are **not encrypted**. A helper-generated chunk checksum detects transfer corruption, not deliberate tampering by that helper. A trusted publisher's SHA-256 lets the host verify the complete file before publication. Without it, the displayed SHA-256 is only a fingerprint.
- Stop or quit cancels the Together session and removes its incomplete file. Together does not yet support pause, crash recovery, or persistence. A force-kill/power loss can leave a `.plexo` partial file beside the destination; it cannot be resumed in this mode.
- No cloud relay, NAT traversal, QR-camera flow, or cross-internet pairing. Join codes contain the LAN address, port and a random token. Codes expire when the session stops, or 30 seconds after completion/failure.
- Real-world speed depends on independent upstream capacity, local transfer speed, server limits and OS routing. Two-instance automated tests verify cooperation and file integrity; they do not establish a speed increase on physical devices.

## Implementation

`src/main/together/session.ts` owns the host coordinator and helper lifecycle. It uses bounded HTTP messages, expiring chunk leases, a separate peer credential after joining, one outstanding lease per helper, and rejects browser-origin requests. A lease is checked again after upload before any file write, so late/duplicate uploads cannot overwrite a reassigned or completed chunk. Writes use fixed offsets in an exclusively reserved destination-side staging file. Publication reuses the existing collision-aware `DownloadFile` implementation.

`transport.ts` uses Plexo's `StreamConnection` to bind source requests to the participant's selected interface. Transfers to the host follow the OS route to the selected local address. Chunk bodies are bounded to 1 MiB, and network operations have deadlines. The host keeps working when helpers leave; returned pieces are attributed only after successful writes.

The UI and typed IPC live alongside the solo downloader. Together session shutdown participates in the app's existing quit cleanup. No dependencies were added.

## Verification

```bash
npm run typecheck
npm run lint
npm run format:check
npx playwright test e2e/together.spec.ts
npm run test:e2e:smoke
```

Tests cover two real Electron windows (host/review/join/download), exact output hashes, contributions, chosen helper source address where available, budget exhaustion, graceful departure, abandoned leases, wrong publisher hashes, invalid tokens/browser origins, malformed/duplicate chunks, changed sources, stop/restart, quit cleanup and unsupported sources.

## Native phone relay protocol (task 4)

The target's existing LAN HTTP listener can accept chunks from native phone clients as well as Plexo desktop helpers. A phone app is not included in this repository yet. The phone client must choose its own source network; Plexo cannot force a phone to use cellular data while keeping a local Wi-Fi route. Browser-origin requests remain rejected.

Parse the join code as `plexo://HOST:PORT/TOKEN` and connect to `http://HOST:PORT`. Send `Authorization: Bearer TOKEN` on every request. All responses are JSON; non-200 responses contain an `error` string. Do not log or publish the token.

1. `GET /session`: review the file metadata with the user, including the source URL, total bytes and optional publisher checksum.
2. `POST /join` with JSON `{ "name": "My phone" }`: receive a `peer` credential. Send it as `X-Plexo-Peer` on subsequent requests.
3. `POST /lease` with JSON `{ "remaining": 10485760 }`: report remaining source-payload budget in bytes. Receive `{ status, lease, bytes }`. A lease contains `id`, `index`, `start` and inclusive `end`. Poll with a short delay when the lease is null; stop on completed, stopped or error status. Repeated polls do not extend a lease.
4. Fetch the assigned source range using `Range: bytes=START-END`, `If-Match: ETAG` and `Accept-Encoding: identity`. Require HTTP 206, the exact Content-Range and ETag, and the exact byte count. Count failed source payload toward the user's allowance too.
5. `POST /chunk` with the raw bytes, exact `Content-Length`, `X-Plexo-Lease: ID` and `X-Plexo-Sha256: HEX_DIGEST`. A successful response means the target wrote the chunk at its assigned offset. The target rejects expired and duplicate uploads and only publishes after every piece is written and final verification passes.
6. If fetching or uploading fails, `POST /failed` with JSON `{ "id": "LEASE_ID" }`. The target releases the matching lease immediately and gives that helper a 45-second cooldown so another participant can claim the work. Failure reports are idempotent and cannot release another participant's lease or interrupt a write. Desktop helpers recover from up to two consecutive chunk failures and leave after the third; a successful chunk resets the counter.
7. `POST /leave` with JSON `{}` when done helping or canceled. This immediately releases unfinished assignments. If the phone disappears without reporting failure, its lease expires after 45 seconds. Expired helpers also receive a cooldown when the expired lease is reclaimed, preventing a slow participant from immediately taking it back.

Keep one chunk in memory at a time (at most 1 MiB). Source and relay requests have 30-second deadlines in the desktop client. If an upload response is lost, a later failure report cannot undo an already accepted chunk; contribution accounting remains authoritative on the host. Plain HTTP is for trusted local networks only. Real phone testing and a native phone UI are still required before claiming mobile end-to-end support.
