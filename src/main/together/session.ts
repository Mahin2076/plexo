import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, statfs } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  HostTogetherRequest,
  JoinTogetherRequest,
  TogetherFile,
  TogetherLease,
  TogetherPeer,
  TogetherState
} from '../../shared/together'
import type { NetworkInterfaceInfo } from '../../shared/types'
import { DownloadFile } from '../download/downloadFile'
import { reserveDestinationPath } from '../download/paths'
import { probeUrl } from '../download/probe'
import {
  callPeer,
  CHUNK_BYTES,
  fetchPiece,
  hash,
  lanAddress,
  LEASE_MS,
  readBody,
  validateFile
} from './transport'

type Networks = {
  refresh(): Promise<NetworkInterfaceInfo[]>
  find(id: string): NetworkInterfaceInfo | undefined
}
type Block = {
  start: number
  end: number
  done: boolean
  failures: number
  lease?: TogetherLease & { owner: string; expires: number; writing: boolean }
}
type Peer = TogetherPeer & { lastSeen: number; retryAfter?: number }
type Assignment = { status: TogetherState['status']; lease: TogetherLease | null; bytes: number }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const json = (res: ServerResponse, value: unknown, status = 200): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Session-local leases never survive a restart. Existing solo downloads keep their own lifecycle. */
export class TogetherSession {
  private state: TogetherState | null = null
  private stop = new AbortController()
  private server?: Server
  private file?: DownloadFile
  private blocks: Block[] = []
  private peers = new Map<string, Peer>()
  private jobs = new Set<Promise<unknown>>()
  private run?: Promise<void>
  private busy = false
  private expiry?: NodeJS.Timeout
  private helper?: { code: string; peer: string }

  constructor(private readonly networks: Networks) {}

  snapshot(): TogetherState | null {
    if (this.state?.role === 'host') {
      this.state.peers = [...this.peers.values()].map(({ name, bytes, status, lastSeen }) => ({
        name,
        bytes,
        status: Date.now() - lastSeen > LEASE_MS ? 'left' : status
      }))
    }
    return this.state && structuredClone(this.state)
  }

  private available(): void {
    if (
      this.busy ||
      (this.state && ['waiting', 'downloading', 'verifying'].includes(this.state.status))
    )
      throw new Error('Stop the current Together session first')
  }

  async host(request: HostTogetherRequest): Promise<TogetherState> {
    this.available()
    this.busy = true
    try {
      await this.close()
      this.stop = new AbortController()
      const networks = await this.networks.refresh()
      if (!this.networks.find(request.internetInterfaceId))
        throw new Error('Select an internet connection')
      if (
        !lanAddress(request.lanAddress) ||
        !networks.some((network) =>
          network.addresses.some((address) => address.address === request.lanAddress)
        )
      )
        throw new Error('Select a local IPv4 address for joining')
      const probe = await probeUrl(request.url)
      if (
        !probe.supportsRanges ||
        !probe.totalBytes ||
        !probe.etag ||
        !/^"[^\r\n]*"$/.test(probe.etag)
      )
        throw new Error(
          'Together needs a file with byte-range support, a known size, and a strong ETag. Use a normal download for this link.'
        )
      const file = validateFile({
        protocol: 1,
        id: randomUUID(),
        url: probe.finalUrl,
        fileName: probe.suggestedFileName,
        totalBytes: probe.totalBytes,
        etag: probe.etag,
        ...(request.expectedSha256?.trim()
          ? { expectedSha256: request.expectedSha256.trim().toLowerCase() }
          : {})
      })
      const disk = await statfs(request.destinationDir)
      if (disk.bavail * disk.bsize < file.totalBytes) throw new Error('Not enough free disk space')
      const destinationPath = await reserveDestinationPath(request.destinationDir, file.fileName)
      this.file = new DownloadFile(`${destinationPath}.plexo`)
      this.blocks = Array.from(
        { length: Math.ceil(file.totalBytes / CHUNK_BYTES) },
        (_, index) => ({
          start: index * CHUNK_BYTES,
          end: Math.min((index + 1) * CHUNK_BYTES, file.totalBytes) - 1,
          done: false,
          failures: 0
        })
      )
      this.peers.clear()
      const token = randomBytes(16).toString('hex')
      this.state = {
        role: 'host',
        status: 'waiting',
        file,
        bytes: 0,
        contributedBytes: 0,
        usedBytes: 0,
        peers: [],
        destinationPath
      }
      this.server = createServer((req, res) => {
        const job = this.serve(req, res, token).catch((error) => {
          if (!res.headersSent && !res.destroyed) json(res, { error: message(error) }, 400)
          else res.destroy()
        })
        this.jobs.add(job)
        void job.finally(() => this.jobs.delete(job))
      })
      this.server.requestTimeout = 30_000
      this.server.headersTimeout = 10_000
      this.server.maxConnections = 12
      this.server.on('connection', (socket) => socket.setTimeout(30_000, () => socket.destroy()))
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(0, request.lanAddress, () => {
          this.server!.off('error', reject)
          resolve()
        })
      })
      this.server.on('error', (error) => {
        void this.fail(error)
      })
      this.state.code = `plexo://${request.lanAddress}:${(this.server.address() as AddressInfo).port}/${token}`
      this.hostNetwork = request.internetInterfaceId
      return this.snapshot()!
    } catch (error) {
      await this.close()
      this.state = null
      throw error
    } finally {
      this.busy = false
    }
  }

  private hostNetwork = ''

  start(): void {
    if (this.busy || this.state?.role !== 'host' || this.state.status !== 'waiting')
      throw new Error('Create a host session first')
    this.state.status = 'downloading'
    this.run = this.hostWorker().catch((error) => this.fail(error))
  }

  async preview(code: string): Promise<TogetherFile> {
    return validateFile(await callPeer<TogetherFile>(code, '/session'))
  }

  async join(request: JoinTogetherRequest): Promise<TogetherState> {
    this.available()
    this.busy = true
    try {
      await this.close()
      this.stop = new AbortController()
      await this.networks.refresh()
      if (!this.networks.find(request.internetInterfaceId))
        throw new Error('Select an internet connection')
      if (!Number.isSafeInteger(request.budgetBytes) || request.budgetBytes < CHUNK_BYTES)
        throw new Error('Choose a data limit of at least 1 MiB')
      const file = await this.preview(request.code)
      if (JSON.stringify(file) !== JSON.stringify(validateFile(request.file)))
        throw new Error('The session changed. Review the file and join again.')
      const { peer } = await callPeer<{ peer: string }>(request.code, '/join', {
        name: request.name
      })
      this.helper = { code: request.code, peer }
      this.state = {
        role: 'helper',
        status: 'waiting',
        file,
        bytes: 0,
        contributedBytes: 0,
        usedBytes: 0,
        budgetBytes: request.budgetBytes,
        peers: []
      }
      this.run = this.helperWorker(request).catch((error) => this.fail(error))
      return this.snapshot()!
    } finally {
      this.busy = false
    }
  }

  private claim(owner: string, remaining: number): TogetherLease | null {
    const now = Date.now()
    for (const block of this.blocks) {
      if (block.lease && !block.lease.writing && block.lease.expires <= now) {
        const peer = this.peers.get(block.lease.owner)
        if (peer) peer.retryAfter = now + LEASE_MS
        block.lease = undefined
      }
    }
    if ((this.peers.get(owner)?.retryAfter ?? 0) > now) return null
    // One outstanding chunk per helper; repeated polls return that same assignment.
    const existing = this.blocks.find((block) => block.lease?.owner === owner)
    if (existing?.lease) return existing.lease
    const index = this.blocks.findIndex(
      (block) => !block.done && !block.lease && block.end - block.start + 1 <= remaining
    )
    if (index < 0) return null
    const block = this.blocks[index]
    const lease = {
      id: randomUUID(),
      index,
      start: block.start,
      end: block.end,
      owner,
      expires: now + LEASE_MS,
      writing: false
    }
    block.lease = lease
    return lease
  }

  private async accept(owner: string, lease: TogetherLease, bytes: Buffer): Promise<void> {
    const block = this.blocks[lease.index]
    if (
      this.stop.signal.aborted ||
      this.state?.status !== 'downloading' ||
      !block ||
      block.done ||
      block.lease?.id !== lease.id ||
      block.lease.owner !== owner ||
      block.lease.expires <= Date.now() ||
      block.lease.writing ||
      bytes.length !== block.end - block.start + 1
    )
      throw new Error('The chunk assignment expired or was already completed')
    block.lease.writing = true
    try {
      const handle = await open(this.file!.path, 'r+')
      try {
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(
            bytes,
            offset,
            bytes.length - offset,
            block.start + offset
          )
          if (!bytesWritten) throw new Error('Could not write the downloaded chunk')
          offset += bytesWritten
        }
      } finally {
        await handle.close()
      }
      block.done = true
      block.lease = undefined
      this.state.bytes += bytes.length
      if (owner === 'host') this.state.contributedBytes += bytes.length
      else {
        const peer = this.peers.get(owner)!
        peer.bytes += bytes.length
        peer.status = 'connected'
      }
    } catch (error) {
      block.lease = undefined
      // Disk errors must stop the whole session, not repeatedly assign the same write.
      this.stop.abort()
      this.state.status = 'error'
      this.state.error = message(error)
      throw error
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
      json(res, { error: 'Invalid session code' }, 403)
      return
    }
    const state = this.state!
    if (req.method === 'GET' && req.url === '/session') {
      json(res, state.file)
      return
    }
    if (req.method !== 'POST') {
      json(res, { error: 'Unknown operation' }, 404)
      return
    }
    if (req.url === '/join') {
      if (!['waiting', 'downloading'].includes(state.status))
        throw new Error('The session is no longer accepting helpers')
      if (this.peers.size >= 4)
        throw new Error(
          'This session already has four helpers; create a new session to reset invitations'
        )
      const body = JSON.parse((await readBody(req, 1024)).toString())
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 48)
        throw new Error('Use a name between 1 and 48 characters')
      const peer = randomBytes(16).toString('hex')
      this.peers.set(peer, {
        name: body.name.trim(),
        bytes: 0,
        status: 'connected',
        lastSeen: Date.now()
      })
      json(res, { peer })
      return
    }
    const peerId = String(req.headers['x-plexo-peer'] ?? '')
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error('Join the session first')
    peer.lastSeen = Date.now()
    if (req.url === '/leave') {
      peer.status = 'left'
      for (const block of this.blocks)
        if (block.lease?.owner === peerId && !block.lease.writing) block.lease = undefined
      json(res, { ok: true })
      return
    }
    if (peer.status === 'left') throw new Error('This helper has left the session')
    if (req.url === '/lease') {
      const body = JSON.parse((await readBody(req, 1024)).toString())
      if (!Number.isSafeInteger(body.remaining) || body.remaining < 0)
        throw new Error('Invalid remaining budget')
      const lease = state.status === 'downloading' ? this.claim(peerId, body.remaining) : null
      peer.status = lease ? 'working' : 'connected'
      json(res, {
        status: state.status,
        lease: lease && { id: lease.id, index: lease.index, start: lease.start, end: lease.end },
        bytes: state.bytes
      } satisfies Assignment)
      return
    }
    if (req.url === '/failed') {
      const body = JSON.parse((await readBody(req, 1024)).toString())
      if (typeof body.id !== 'string') throw new Error('Invalid chunk assignment')
      const block = this.blocks.find(
        (item) => item.lease && item.lease.id === body.id && item.lease.owner === peerId
      )
      // Idempotent: a delayed failure must never release a replacement lease or an active write.
      if (block?.lease && !block.lease.writing) {
        block.lease = undefined
        peer.retryAfter = Date.now() + LEASE_MS
        peer.status = 'connected'
      }
      json(res, { ok: true })
      return
    }
    if (req.url === '/chunk') {
      const block = this.blocks.find(
        (item) =>
          item.lease &&
          item.lease.id === req.headers['x-plexo-lease'] &&
          item.lease.owner === peerId
      )
      if (!block?.lease || state.status !== 'downloading')
        throw new Error('This chunk is no longer needed')
      const lease = block.lease
      const expected = block.end - block.start + 1
      if (Number(req.headers['content-length']) !== expected)
        throw new Error('Incorrect chunk size')
      const bytes = await readBody(req, expected)
      if (hash(bytes) !== req.headers['x-plexo-sha256']) throw new Error('Chunk checksum mismatch')
      await this.accept(peerId, lease, bytes)
      json(res, { ok: true })
      return
    }
    throw new Error('Unknown operation')
  }

  private async hostWorker(): Promise<void> {
    const signal = this.stop.signal
    while (!signal.aborted && !this.blocks.every((block) => block.done)) {
      const lease = this.claim('host', CHUNK_BYTES)
      if (!lease) {
        await delay(200, undefined, { signal })
        continue
      }
      try {
        const bytes = await fetchPiece(
          this.state!.file,
          lease,
          () => this.networks.find(this.hostNetwork),
          signal,
          (count) => {
            this.state!.usedBytes += count
          }
        )
        await this.accept('host', lease, bytes)
      } catch (error) {
        const block = this.blocks[lease.index]
        if (block.lease?.id === lease.id) block.lease = undefined
        if (signal.aborted || ++block.failures >= 3) throw error
        await delay(500, undefined, { signal })
      }
    }
    signal.throwIfAborted()
    this.state!.status = 'verifying'
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(this.file!.path, { signal })) digest.update(bytes)
    const sha256 = digest.digest('hex')
    if (this.state!.file.expectedSha256 && sha256 !== this.state!.file.expectedSha256)
      throw new Error(
        'Final SHA-256 does not match the supplied checksum. The file was not published.'
      )
    this.state!.destinationPath = await this.file!.publish(
      this.state!.destinationPath!,
      this.state!.file.totalBytes,
      async () => {
        signal.throwIfAborted()
      }
    )
    this.file = undefined
    this.state!.sha256 = sha256
    this.state!.status = 'completed'
    this.expireServer()
  }

  private async helperWorker(request: JoinTogetherRequest): Promise<void> {
    const signal = this.stop.signal
    const peer = this.helper!.peer
    const headers = { 'X-Plexo-Peer': peer }
    let consecutiveFailures = 0
    try {
      while (!signal.aborted) {
        const remaining = Math.max(0, request.budgetBytes - this.state!.usedBytes)
        const assignment = await callPeer<Assignment>(
          request.code,
          '/lease',
          { remaining },
          signal,
          headers
        )
        this.state!.bytes = assignment.bytes
        if (assignment.status === 'completed') {
          this.state!.status = 'completed'
          return
        }
        if (['stopped', 'error'].includes(assignment.status))
          throw new Error('The host stopped this session')
        this.state!.status = assignment.status
        if (remaining < Math.min(CHUNK_BYTES, this.state!.file.totalBytes)) {
          this.state!.status = 'stopped'
          return
        }
        if (!assignment.lease) {
          await delay(350, undefined, { signal })
          continue
        }
        const lease = assignment.lease
        if (lease.end - lease.start + 1 > remaining)
          throw new Error('Assignment exceeds your remaining data budget')
        try {
          const bytes = await fetchPiece(
            this.state!.file,
            lease,
            () => this.networks.find(request.internetInterfaceId),
            signal,
            (count) => {
              this.state!.usedBytes += count
            }
          )
          await callPeer(request.code, '/chunk', bytes, signal, {
            ...headers,
            'X-Plexo-Lease': lease.id,
            'X-Plexo-Sha256': hash(bytes)
          })
          this.state!.contributedBytes += bytes.length
          consecutiveFailures = 0
        } catch (error) {
          if (signal.aborted) throw error
          // Release immediately rather than making the host wait for lease expiry.
          // If the LAN itself is down, the lease deadline remains the fallback.
          await callPeer(
            request.code,
            '/failed',
            { id: lease.id },
            AbortSignal.any([signal, AbortSignal.timeout(1500)]),
            headers
          ).catch(() => {})
          if (++consecutiveFailures >= 3) throw error
          await delay(500, undefined, { signal })
        }
      }
    } finally {
      await callPeer(request.code, '/leave', {}, AbortSignal.timeout(1500), headers).catch(() => {})
    }
  }

  private expireServer(): void {
    clearTimeout(this.expiry)
    // Let helpers observe completion/failure, then revoke the code and close the listener.
    this.expiry = setTimeout(() => {
      this.server?.closeAllConnections()
      this.server?.close()
      this.server = undefined
    }, 30_000)
    this.expiry.unref()
  }

  private async fail(error: unknown): Promise<void> {
    if (this.state && this.state.status !== 'stopped' && this.state.status !== 'completed') {
      this.state.status = 'error'
      this.state.error = message(error)
    }
    this.stop.abort()
    if (this.server) this.expireServer()
    // No new leases after failure. Wait for any upload write before deleting staging data.
    await Promise.allSettled([...this.jobs])
    try {
      await this.file?.discard()
      this.file = undefined
    } catch (cleanupError) {
      if (this.state)
        this.state.error = `${this.state.error ?? message(error)}. Could not remove the partial file: ${message(cleanupError)}`
    }
  }

  private async close(): Promise<void> {
    clearTimeout(this.expiry)
    this.stop.abort()
    if (this.state && !['completed', 'error'].includes(this.state.status))
      this.state.status = 'stopped'
    const server = this.server
    this.server = undefined
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await this.run
    this.run = undefined
    await Promise.allSettled([...this.jobs])
    await this.file?.discard()
    this.file = undefined
    this.helper = undefined
    clearTimeout(this.expiry)
  }

  async stopSession(): Promise<void> {
    if (this.busy) throw new Error('Wait for session setup to finish')
    this.busy = true
    try {
      await this.close()
    } finally {
      this.busy = false
    }
  }
}
