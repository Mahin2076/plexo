import type {
  JoinUrl,
  JoinedDevice,
  JoinedDevicePlatform,
  NetworkInterfaceInfo,
  NetworkInterfaceKind
} from '../../shared/types'

// What the phone sends back, and how it becomes a JoinedDevice. Pure — no Electron, no sockets —
// so the e2e suite can run its property tests against it directly.

/** The body the phone POSTs to /api/join/report once it has measured. Internet figures are null
 * when it couldn't reach the probe. Speeds are bytes per second. */
export interface SpeedTestReport {
  internetLatencyMs: number | null
  internetDownloadBps: number | null
  internetUploadBps: number | null
  linkLatencyMs: number
  linkDownloadBps: number
  linkUploadBps: number
  durationMs: number
  /** The Network Information API's effectiveType ("4g"), when the browser offers it. */
  connectionType?: string
}

/** effectiveType is a handful of characters; anything longer isn't it. */
const MAX_CONNECTION_TYPE_LENGTH = 32

/** The order a session's links are listed in: the kinds a phone is likeliest to share with this
 * computer first. */
const KIND_ORDER: NetworkInterfaceKind[] = ['wifi', 'usb', 'ethernet', 'bridge', 'other']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A measurement is a finite, non-negative number — NaN, Infinity and negatives are all signs
 * the phone's arithmetic went wrong, not figures to show. */
function isMeasurement(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isOptionalMeasurement(value: unknown): value is number | null {
  return value === null || isMeasurement(value)
}

/** null when `body` isn't a report: wrong shape, a non-finite or negative figure, a
 * connectionType that isn't a short string. Internet figures may be null; connectionType may be
 * missing (or null, which JSON can carry where undefined can't). Fields it doesn't know are
 * dropped. */
export function parseSpeedTestReport(body: unknown): SpeedTestReport | null {
  if (!isRecord(body)) return null
  const {
    internetLatencyMs,
    internetDownloadBps,
    internetUploadBps,
    linkLatencyMs,
    linkDownloadBps,
    linkUploadBps,
    durationMs,
    connectionType
  } = body
  if (
    !isOptionalMeasurement(internetLatencyMs) ||
    !isOptionalMeasurement(internetDownloadBps) ||
    !isOptionalMeasurement(internetUploadBps) ||
    !isMeasurement(linkLatencyMs) ||
    !isMeasurement(linkDownloadBps) ||
    !isMeasurement(linkUploadBps) ||
    !isMeasurement(durationMs)
  ) {
    return null
  }
  const hasConnectionType = connectionType !== undefined && connectionType !== null
  if (
    hasConnectionType &&
    (typeof connectionType !== 'string' || connectionType.length > MAX_CONNECTION_TYPE_LENGTH)
  ) {
    return null
  }
  return {
    internetLatencyMs,
    internetDownloadBps,
    internetUploadBps,
    linkLatencyMs,
    linkDownloadBps,
    linkUploadBps,
    durationMs,
    ...(hasConnectionType ? { connectionType } : {})
  }
}

/** What to call the phone, from its browser's User-Agent. iPad is checked before iPhone only
 * out of caution — neither string appears in the other's UA, but the order costs nothing. */
export function describeDevice(userAgent: string | undefined): {
  name: string
  platform: JoinedDevicePlatform
} {
  const agent = userAgent ?? ''
  if (/ipad/i.test(agent)) return { name: 'iPad', platform: 'ios' }
  if (/iphone/i.test(agent)) return { name: 'iPhone', platform: 'ios' }
  if (/android/i.test(agent)) return { name: 'Android phone', platform: 'android' }
  return { name: 'Phone', platform: 'other' }
}

/** A dual-stack socket reports an IPv4 peer as IPv4-mapped IPv6 ("::ffff:192.168.1.5"). This
 * gives back the plain IPv4, and leaves anything else — a real IPv6 address, undefined — alone. */
export function normalizeAddress(address: string | undefined): string | undefined {
  if (address === undefined) return undefined
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return mapped ? mapped[1] : address
}

/** The id of the interface that owns `localAddress` — the network of this computer a phone's
 * connection came in on — or undefined when none does. */
export function findInterfaceByAddress(
  interfaces: NetworkInterfaceInfo[],
  localAddress: string | undefined
): string | undefined {
  const address = normalizeAddress(localAddress)?.toLowerCase()
  if (address === undefined) return undefined
  return interfaces.find((iface) =>
    iface.addresses.some((entry) => entry.address.toLowerCase() === address)
  )?.id
}

/** One join link per network this computer has an IPv4 address on (its first IPv4 — phones
 * reliably reach a LAN IPv4, while a global IPv6 may not be the one the phone's network uses).
 * Wi-Fi first, then USB, ethernet, bridge, other; the OS's order within each kind. */
export function buildJoinUrls(
  interfaces: NetworkInterfaceInfo[],
  port: number,
  token: string
): JoinUrl[] {
  const query = encodeURIComponent(token)
  return KIND_ORDER.flatMap((kind) =>
    interfaces.flatMap((iface) => {
      if (iface.kind !== kind) return []
      const ipv4 = iface.addresses.find((entry) => entry.family === 4)
      if (!ipv4) return []
      return [
        {
          interfaceId: iface.id,
          label: iface.displayName,
          url: `http://${ipv4.address}:${port}/join?t=${query}`
        }
      ]
    })
  )
}

/** A parsed report plus what the request itself said about the phone, as one JoinedDevice.
 * `now` is both when it joined and when the report was received. */
export function toJoinedDevice(args: {
  id: string
  report: SpeedTestReport
  userAgent: string | undefined
  address: string
  viaInterfaceId: string | undefined
  now: number
}): JoinedDevice {
  const { id, report, userAgent, address, viaInterfaceId, now } = args
  const { name, platform } = describeDevice(userAgent)
  return {
    id,
    name,
    platform,
    ...(report.connectionType !== undefined ? { connectionType: report.connectionType } : {}),
    address,
    ...(viaInterfaceId !== undefined ? { viaInterfaceId } : {}),
    joinedAt: now,
    capability: {
      internetLatencyMs: report.internetLatencyMs,
      internetDownloadBps: report.internetDownloadBps,
      internetUploadBps: report.internetUploadBps,
      linkLatencyMs: report.linkLatencyMs,
      linkDownloadBps: report.linkDownloadBps,
      linkUploadBps: report.linkUploadBps,
      measuredAt: now,
      durationMs: report.durationMs
    }
  }
}
