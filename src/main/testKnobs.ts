import { app } from 'electron'
import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from '../shared/types'

// Overrides for the end-to-end suite (e2e/), read from the environment. A packaged build ignores
// all of them, so a shipped app can't be steered through its environment variables.
const env: NodeJS.ProcessEnv = app.isPackaged ? {} : process.env

function positiveNumber(name: string, fallback: number): number {
  const value = Number(env[name])
  return value > 0 ? value : fallback
}

export const testKnobs = {
  userDataDir: env['PLEXO_USER_DATA'],
  /** Keeps the window off-screen so a test run doesn't pop windows up over the desktop. */
  hideWindow: env['PLEXO_E2E_HIDE_WINDOW'] === '1',
  blockBytes: positiveNumber('PLEXO_E2E_BLOCK_BYTES', 8 * 1024 * 1024),
  retryBaseDelayMs: positiveNumber('PLEXO_E2E_RETRY_BASE_MS', 1000),
  stallTimeoutMs: positiveNumber('PLEXO_E2E_STALL_MS', 20_000),
  connectTimeoutMs: positiveNumber('PLEXO_E2E_CONNECT_MS', 10_000),
  /** How long a server that keeps answering busy (429, 503, …) is waited out; see
   * downloadManager.ts. */
  serverBusyForMs: positiveNumber('PLEXO_E2E_SERVER_BUSY_MS', 5 * 60_000),
  slowWarmupMs: positiveNumber('PLEXO_E2E_SLOW_WARMUP_MS', 5_000),
  slowForMs: positiveNumber('PLEXO_E2E_SLOW_FOR_MS', 10_000),
  silentAfterMs: positiveNumber('PLEXO_E2E_SILENT_MS', 5_000),
  hedgeAfterMs: positiveNumber('PLEXO_E2E_HEDGE_MS', 2_000),
  /** Skips the real GitHub check and pretends this version is available, for exercising the
   * update banner without needing an actual newer release published. */
  forceUpdateVersion: env['PLEXO_FORCE_UPDATE_VERSION'],
  /** The port the join server listens on; 0 lets the OS pick a free one. */
  joinPort: positiveNumber('PLEXO_E2E_JOIN_PORT', 0),
  /** The address the join server binds; every address (so a phone on any network reaches it)
   * unless a test wants it on loopback only. */
  joinHost: env['PLEXO_E2E_JOIN_HOST'],
  /** How long a join link stays valid once shown. */
  joinSessionTtlMs: positiveNumber('PLEXO_E2E_JOIN_TTL_MS', 10 * 60_000),
  /** Where the phone measures its internet speed. Unset: Cloudflare's speed test endpoints.
   * `self`: the join server's own endpoints (so a test measures something without the
   * internet). `none`: skip the internet measurement. Any other value: an origin that serves
   * Cloudflare's `/__down?bytes=` and `/__up` paths. */
  speedTestOrigin: env['PLEXO_E2E_SPEEDTEST_ORIGIN']
}

/** `PLEXO_E2E_STREAMS=2` fixes how many streams each network runs and turns the automatic
 * sizing off, so a test can count requests. Read on every call rather than once, so a test can
 * change it between downloads. */
export function testStreamsPerNetwork(): number | null {
  if (app.isPackaged) return null
  const value = Number(process.env['PLEXO_E2E_STREAMS'])
  return value > 0 ? value : null
}

/** `PLEXO_E2E_INTERFACES=a=127.0.0.1,b=192.168.1.5` replaces the real interface list. Read on
 * every call rather than once, so a test can make a network "disappear" mid-download by
 * rewriting process.env in the main process. */
export function testInterfaces(): NetworkInterfaceInfo[] | null {
  if (app.isPackaged) return null
  const raw = process.env['PLEXO_E2E_INTERFACES']
  if (raw === undefined) return null
  return raw
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [id, address, subnet, kind] = entry.split('=')
      const inferredKind =
        kind === 'wifi' || id.toLowerCase().includes('wi-fi') || id.toLowerCase().includes('wifi')
          ? ('wifi' as const)
          : ('ethernet' as const)
      return {
        id,
        device: id,
        displayName: id,
        addresses: [{ address, family: isIP(address) === 6 ? 6 : 4, subnet: subnet || undefined }],
        kind: inferredKind
      }
    })
}
