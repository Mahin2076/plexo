import { randomBytes, randomUUID } from 'node:crypto'
import type {
  JoinSession,
  JoinState,
  JoinUrl,
  JoinedDevice,
  NetworkInterfaceInfo,
  SpeedTestPhase
} from '../../shared/types'
import type { NetworkMonitor } from '../network/interfaces'
import { testKnobs } from '../testKnobs'
import { JoinServer, type JoinServerHooks, type ReportMeta } from './joinServer'
import {
  buildJoinUrls,
  findInterfaceByAddress,
  toJoinedDevice,
  type SpeedTestReport
} from './report'

// The session bookkeeping behind the Join QR code: which link is live, what the phone has said
// so far, and every phone that has reported this run. The HTTP side is JoinServer's; this never
// sees a request. State is replaced, never edited, so what onChange hands out is a snapshot.

const NO_NETWORK_MESSAGE = 'No network a phone could reach this computer on'

function hasIpv4(iface: NetworkInterfaceInfo): boolean {
  return iface.addresses.some((entry) => entry.family === 4)
}

function sameUrls(a: JoinUrl[], b: JoinUrl[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, i) =>
        entry.interfaceId === b[i].interfaceId &&
        entry.label === b[i].label &&
        entry.url === b[i].url
    )
  )
}

/** `existing` measured again: the device stays itself (id, name, platform) and everything
 * measured is replaced — including where from, since the phone may have switched networks in
 * between — rather than merged, so a connectionType it didn't repeat isn't kept stale. */
function remeasured(existing: JoinedDevice, measured: JoinedDevice): JoinedDevice {
  const { id, name, platform } = existing
  return { ...measured, id, name, platform }
}

/** `session` minus what its last attempt produced (phase, error), so the next attempt starts
 * clean of them. deviceId stays: a report after "Test again" replaces that device. */
function withoutOutcome(session: JoinSession): JoinSession {
  const { id, status, urls, createdAt, expiresAt, deviceId } = session
  return { id, status, urls, createdAt, expiresAt, ...(deviceId !== undefined ? { deviceId } : {}) }
}

export class JoinManager {
  private session: JoinSession | null = null
  /** The open session's secret — kept off the session itself, which goes to the window. Null
   * whenever the link shouldn't work: no session, or one that expired. */
  private token: string | null = null
  private devices: JoinedDevice[] = []
  private server: JoinServer | null = null
  /** `server`'s port, settled once it listens; what two quick starts share. */
  private listening: Promise<number> | null = null
  /** The port, once `listening` settled; null while binding or when no server runs. */
  private port: number | null = null
  private expiry: NodeJS.Timeout | null = null

  constructor(
    private readonly networks: NetworkMonitor,
    private readonly onChange: (state: JoinState) => void
  ) {}

  /** Opens a session, replacing any open one, and starts the server if it isn't running. Throws
   * when no network has an IPv4 address: there'd be nothing to put in the QR code. */
  async start(): Promise<JoinState> {
    const interfaces = this.networks.current ?? (await this.networks.refresh())
    if (!interfaces.some(hasIpv4)) throw new Error(NO_NETWORK_MESSAGE)
    const port = await this.ensureServer()

    this.clearExpiry()
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    this.token = token
    this.session = {
      id: randomUUID(),
      status: 'waiting',
      urls: buildJoinUrls(interfaces, port, token),
      createdAt: now,
      expiresAt: now + testKnobs.joinSessionTtlMs
    }
    // unref'd: an open link must not keep the process alive once the window is gone.
    this.expiry = setTimeout(() => void this.expire(), testKnobs.joinSessionTtlMs)
    this.expiry.unref()
    return this.publish()
  }

  /** Closes the open session and stops the server. Devices are kept. */
  async stop(): Promise<void> {
    this.clearExpiry()
    if (this.session !== null) {
      this.session = null
      this.token = null
      this.publish()
    }
    await this.stopServer()
  }

  getState(): JoinState {
    const { session } = this
    return {
      session: session ? { ...session, urls: session.urls.map((url) => ({ ...url })) } : null,
      devices: this.devices.map((device) => ({ ...device, capability: { ...device.capability } }))
    }
  }

  removeDevice(id: string): void {
    if (!this.devices.some((device) => device.id === id)) return
    this.devices = this.devices.filter((device) => device.id !== id)
    this.publish()
  }

  /** For app quit: the server's connections are dropped, so a phone mid-download can't hold it. */
  shutdown(): Promise<void> {
    return this.stop()
  }

  /** The computer's networks changed (see NetworkMonitor): the links an open session offers
   * follow, so the QR code never points at an address this computer no longer has. */
  networksChanged(): void {
    const { session, token, port } = this
    if (session === null || token === null || port === null) return
    const urls = buildJoinUrls(this.networks.current ?? [], port, token)
    if (sameUrls(urls, session.urls)) return
    this.session = { ...session, urls }
    this.publish()
  }

  // --- what the server reports -----------------------------------------------------------------

  private hooks(): JoinServerHooks {
    return {
      currentToken: () => this.token,
      onProgress: (phase) => this.progress(phase),
      onReport: (report, meta) => this.report(report, meta),
      onBadReport: (message) => this.badReport(message)
    }
  }

  private progress(phase: SpeedTestPhase): void {
    const session = this.session
    if (session === null) return
    this.session = { ...withoutOutcome(session), status: 'testing', phase }
    this.publish()
  }

  private report(
    report: SpeedTestReport,
    meta: ReportMeta
  ): { deviceId: string; name: string } | null {
    const session = this.session
    if (session === null) return null
    const existing = this.devices.find((device) => device.id === session.deviceId)
    const measured = toJoinedDevice({
      id: existing?.id ?? randomUUID(),
      report,
      userAgent: meta.userAgent,
      address: meta.address,
      viaInterfaceId: findInterfaceByAddress(this.networks.current ?? [], meta.localAddress),
      now: Date.now()
    })
    const device = existing ? remeasured(existing, measured) : measured
    this.devices = existing
      ? this.devices.map((entry) => (entry.id === device.id ? device : entry))
      : [...this.devices, device]
    this.session = { ...withoutOutcome(session), status: 'done', deviceId: device.id }
    this.publish()
    return { deviceId: device.id, name: device.name }
  }

  private badReport(message: string): void {
    const session = this.session
    if (session === null) return
    this.session = { ...session, error: message }
    this.publish()
  }

  // --- the server and the clock ----------------------------------------------------------------

  private ensureServer(): Promise<number> {
    if (this.listening !== null) return this.listening
    const server = new JoinServer(this.hooks())
    const listening = server.listen().then(({ port }) => port)
    this.server = server
    this.listening = listening
    listening.then(
      (port) => {
        if (this.server === server) this.port = port
      },
      // A failed bind leaves nothing behind, so the next start tries afresh.
      () => {
        if (this.server === server) this.forgetServer()
      }
    )
    return listening
  }

  private async stopServer(): Promise<void> {
    const { server, listening } = this
    this.forgetServer()
    if (server === null) return
    // If it's still binding, let that settle (either way) before closing it.
    await listening?.catch(() => undefined)
    await server.close()
  }

  private forgetServer(): void {
    this.server = null
    this.listening = null
    this.port = null
  }

  private async expire(): Promise<void> {
    this.expiry = null
    const session = this.session
    if (session === null) return
    this.token = null
    this.session = { ...session, status: 'expired' }
    this.publish()
    await this.stopServer()
  }

  private clearExpiry(): void {
    if (this.expiry !== null) clearTimeout(this.expiry)
    this.expiry = null
  }

  private publish(): JoinState {
    const state = this.getState()
    this.onChange(state)
    return state
  }
}
