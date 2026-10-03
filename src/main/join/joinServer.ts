import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import type { SpeedTestPhase } from '../../shared/types'
import { testKnobs } from '../testKnobs'
import { renderJoinPage, type SpeedTestTarget } from './joinPage'
import { normalizeAddress, parseSpeedTestReport, type SpeedTestReport } from './report'

// The tiny HTTP server a phone talks to after scanning the QR code: it serves the join page and
// the endpoints the page measures against, and hands what the phone says to JoinManager through
// JoinServerHooks. It knows nothing about sessions beyond "what is the token right now".

/** The most a single download or upload may measure with. */
export const MAX_TEST_BYTES = 64 * 1024 * 1024
/** A phase or report is a few hundred bytes; anything bigger isn't one. */
const MAX_JSON_BYTES = 64 * 1024
/** How much more of an oversized body is read off and dropped after the 413 went out, so the
 * phone gets to read it — a client still sending can't see a response, and a connection
 * dropped under it loses the response with it. Past this, it's dropped anyway. */
const OVERSIZE_GRACE_BYTES = 2 * MAX_TEST_BYTES
/** Download bodies are this buffer written over and over — random so nothing between the phone
 * and this computer can compress it into a flattering result. */
const FILL = randomBytes(64 * 1024)
/** The page measures in bursts of short requests; keeping the connection open between them
 * means a ping times the network, not a TCP handshake. */
const KEEP_ALIVE_TIMEOUT_MS = 30_000
/** Long enough for the largest upload the server allows over a slow link. */
const REQUEST_TIMEOUT_MS = 120_000
const CLOUDFLARE_ORIGIN = 'https://speed.cloudflare.com'
const EXPIRED_MESSAGE = 'This link has expired. Open Plexo and scan the code again.'
const PHASES: SpeedTestPhase[] = ['latency', 'download', 'upload']

/** What the server learned about the phone from the request that carried its report. Addresses
 * are plain IPv4 where the socket was dual-stack. */
export interface ReportMeta {
  userAgent: string | undefined
  /** The phone's address; empty if the socket had already gone. */
  address: string
  /** The address of this computer the phone reached: which network it came in on. */
  localAddress: string | undefined
}

/** How the server reaches the session bookkeeping it doesn't keep itself. */
export interface JoinServerHooks {
  /** The open session's token, or null when none is open — every route then answers as expired. */
  currentToken(): string | null
  /** The phone has started a measuring phase. */
  onProgress(phase: SpeedTestPhase): void
  /** The phone's report, parsed. What comes back is shown on the phone; null means the session
   * closed while the phone was measuring, and the phone is told the link expired. */
  onReport(report: SpeedTestReport, meta: ReportMeta): { deviceId: string; name: string } | null
  /** The phone POSTed a report that couldn't be read; `message` says so in a sentence. */
  onBadReport(message: string): void
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>

interface Route {
  method: 'GET' | 'POST'
  handle: RouteHandler
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Query strings are compared in constant time: a token is the only thing standing between the
 * LAN and this server, and a byte-at-a-time comparison would leak it one byte per guess. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The server's own endpoints, relative so they work from whichever address the phone used. */
function linkTarget(token: string): SpeedTestTarget {
  const query = encodeURIComponent(token)
  return {
    pingUrl: `/api/join/ping?t=${query}`,
    downloadUrlTemplate: `/api/join/down?t=${query}&bytes={bytes}`,
    uploadUrl: `/api/join/up?t=${query}`
  }
}

/** Cloudflare's speed-test paths on `origin` — Cloudflare itself, or a test's stand-in. */
function cloudflareTarget(origin: string): SpeedTestTarget {
  return {
    pingUrl: `${origin}/__down?bytes=0`,
    downloadUrlTemplate: `${origin}/__down?bytes={bytes}`,
    uploadUrl: `${origin}/__up`
  }
}

/** Where the page measures its internet speed (see testKnobs.speedTestOrigin): a remote origin,
 * this server itself, or nowhere. */
type InternetSource = { origin: string } | 'self' | 'none'

function internetSource(): InternetSource {
  const knob = testKnobs.speedTestOrigin
  if (knob === undefined) return { origin: CLOUDFLARE_ORIGIN }
  if (knob === 'self' || knob === 'none') return knob
  // Throws on a value that isn't a URL — at start, where a test sees it, not on a phone's request.
  return { origin: new URL(knob).origin }
}

function contentSecurityPolicy(nonce: string, connectOrigin: string | null): string {
  const connect = connectOrigin ? `'self' ${connectOrigin}` : `'self'`
  return [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    `connect-src ${connect}`,
    `img-src 'self' data:`,
    `base-uri 'none'`,
    `form-action 'none'`
  ].join('; ')
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'Cache-Control': 'no-store' })
  res.end()
}

/** Reads a body up to `limit` bytes; null once it goes past. Leaving the loop early must not
 * destroy the request (the iterator's default), which would reset the socket under the phone
 * before it could read the 413. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Reads and throws away a body up to `limit` bytes; false once it goes past (see readBody). */
async function discardBody(req: IncomingMessage, limit: number): Promise<boolean> {
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) return false
  }
  return true
}

/** Answers 413 and lets the phone finish sending (within OVERSIZE_GRACE_BYTES) so it can read
 * the answer. The discard starts before the response ends, so the request is already being
 * consumed when Node would otherwise dump it. */
async function sendTooLarge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const drained = discardBody(req, OVERSIZE_GRACE_BYTES)
  res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end('Too large.')
  if (!(await drained)) req.socket.destroy()
}

/** The declared size, when the phone declared one past `limit` — no need to read any of it. */
function declaredTooLarge(req: IncomingMessage, limit: number): boolean {
  const declared = Number(req.headers['content-length'])
  return Number.isFinite(declared) && declared > limit
}

type JsonBodyError = 'too-large' | 'not-json'
type JsonBody = { value: unknown } | { error: JsonBodyError }

function rejectJson(
  req: IncomingMessage,
  res: ServerResponse,
  error: JsonBodyError
): Promise<void> {
  if (error === 'too-large') return sendTooLarge(req, res)
  sendText(res, 400, 'Expected a JSON body.')
  return Promise.resolve()
}

/** Resolves once the response can take more, or once the phone has gone. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

/** Writes `total` bytes of FILL, waiting out backpressure rather than queueing 64 MiB in memory,
 * and stops as soon as the phone hangs up. */
async function pour(res: ServerResponse, total: number): Promise<void> {
  let remaining = total
  while (remaining > 0 && !res.destroyed) {
    const chunk = remaining >= FILL.length ? FILL : FILL.subarray(0, remaining)
    remaining -= chunk.length
    if (!res.write(chunk)) await drained(res)
  }
  if (!res.destroyed) res.end()
}

export class JoinServer {
  private readonly server: Server
  private readonly routes: Record<string, Route>
  private readonly internet: InternetSource
  private readonly hostName: string

  constructor(private readonly hooks: JoinServerHooks) {
    this.internet = internetSource()
    // Bonjour's ".local" is how the OS names the machine on the network, not what the user calls it.
    this.hostName = hostname().replace(/\.local$/i, '')
    this.routes = {
      '/join': { method: 'GET', handle: (req, res, url) => this.servePage(req, res, url) },
      '/api/join/ping': { method: 'GET', handle: async (_req, res) => sendEmpty(res, 204) },
      '/api/join/down': { method: 'GET', handle: (req, res, url) => this.serveDown(req, res, url) },
      '/api/join/up': { method: 'POST', handle: (req, res) => this.serveUp(req, res) },
      '/api/join/progress': {
        method: 'POST',
        handle: (req, res) => this.serveProgress(req, res)
      },
      '/api/join/report': { method: 'POST', handle: (req, res) => this.serveReport(req, res) }
    }
    this.server = createServer((req, res) => this.handle(req, res))
    this.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
    this.server.requestTimeout = REQUEST_TIMEOUT_MS
  }

  /** Binds every address (or testKnobs.joinHost) on testKnobs.joinPort, and reports the port the
   * OS gave. Once per instance. */
  async listen(): Promise<{ port: number }> {
    const host = testKnobs.joinHost ?? '::'
    try {
      await this.bind(host)
    } catch (error) {
      // No IPv6 stack at all (some containers, IPv6 switched off): serve IPv4 alone.
      if (host !== '::' || (error as NodeJS.ErrnoException).code !== 'EAFNOSUPPORT') throw error
      await this.bind('0.0.0.0')
    }
    // Nothing after a successful bind should take the process down.
    this.server.on('error', (error) => console.error('[plexo] join server error', error))
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('The join server has no port')
    }
    return { port: address.port }
  }

  private bind(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.server.once('error', onError)
      this.server.listen({ port: testKnobs.joinPort, host }, () => {
        this.server.off('error', onError)
        resolve()
      })
    })
  }

  /** Stops listening and drops every connection — a phone mid-download must not hold quit. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      // A server that never got to listen reports as much here; nothing to do about it.
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    this.route(req, res).catch((error: unknown) => {
      // The phone hanging up mid-request isn't the server's failure. (req.destroyed is no
      // guide: it's set once any body has been read in full.)
      if (res.destroyed) return
      console.error('[plexo] join server failed to answer', req.method, req.url, error)
      if (res.headersSent) res.destroy()
      else sendText(res, 500, 'Something went wrong.')
    })
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The base only makes the path parse; nothing reads the host from it.
    const url = new URL(req.url ?? '/', 'http://join.invalid')
    const route = this.routes[url.pathname]
    if (!route) return sendText(res, 404, 'Not found.')
    // The token comes before the method: without it, a request learns nothing at all.
    const presented = url.searchParams.get('t')
    const expected = this.hooks.currentToken()
    if (presented === null || expected === null || !tokensMatch(presented, expected)) {
      return sendText(res, 404, EXPIRED_MESSAGE)
    }
    if (req.method !== route.method) {
      res.writeHead(405, {
        Allow: route.method,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      res.end('Method not allowed.')
      return
    }
    await route.handle(req, res, url)
  }

  private async servePage(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Checked by route(); re-read here so the page carries exactly what the phone presented.
    const token = url.searchParams.get('t') ?? ''
    const nonce = randomBytes(16).toString('base64')
    const link = linkTarget(token)
    const internet =
      this.internet === 'none'
        ? null
        : this.internet === 'self'
          ? link
          : cloudflareTarget(this.internet.origin)
    const connectOrigin = typeof this.internet === 'object' ? this.internet.origin : null
    const html = renderJoinPage({
      nonce,
      hostName: this.hostName,
      link,
      internet,
      progressUrl: `/api/join/progress?t=${encodeURIComponent(token)}`,
      reportUrl: `/api/join/report?t=${encodeURIComponent(token)}`
    })
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': contentSecurityPolicy(nonce, connectOrigin),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    })
    res.end(html)
  }

  private async serveDown(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const raw = url.searchParams.get('bytes') ?? ''
    const bytes = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN
    if (!Number.isInteger(bytes) || bytes > MAX_TEST_BYTES) {
      return sendText(res, 400, `bytes must be a whole number up to ${MAX_TEST_BYTES}.`)
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes),
      'Cache-Control': 'no-store'
    })
    await pour(res, bytes)
  }

  private async serveUp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (declaredTooLarge(req, MAX_TEST_BYTES) || !(await discardBody(req, MAX_TEST_BYTES))) {
      return sendTooLarge(req, res)
    }
    sendEmpty(res, 204)
  }

  /** A JSON body, or why there isn't one. */
  private async readJson(req: IncomingMessage): Promise<JsonBody> {
    if (declaredTooLarge(req, MAX_JSON_BYTES)) return { error: 'too-large' }
    const body = await readBody(req, MAX_JSON_BYTES)
    if (body === null) return { error: 'too-large' }
    try {
      return { value: JSON.parse(body.toString('utf8')) }
    } catch {
      return { error: 'not-json' }
    }
  }

  private async serveProgress(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req)
    if ('error' in body) return rejectJson(req, res, body.error)
    const phase = isRecord(body.value) ? body.value.phase : undefined
    if (!PHASES.includes(phase as SpeedTestPhase)) {
      return sendText(res, 400, `phase must be one of ${PHASES.join(', ')}.`)
    }
    this.hooks.onProgress(phase as SpeedTestPhase)
    sendEmpty(res, 204)
  }

  private async serveReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req)
    if ('error' in body) {
      this.hooks.onBadReport(
        body.error === 'too-large'
          ? "The phone's report was too big to be one."
          : "The phone's report wasn't JSON."
      )
      return rejectJson(req, res, body.error)
    }
    const report = parseSpeedTestReport(body.value)
    if (report === null) {
      this.hooks.onBadReport("The phone's report couldn't be read.")
      return sendText(res, 400, 'Not a speed test report.')
    }
    const result = this.hooks.onReport(report, {
      userAgent: req.headers['user-agent'],
      address: normalizeAddress(req.socket.remoteAddress) ?? '',
      localAddress: normalizeAddress(req.socket.localAddress)
    })
    if (result === null) return sendText(res, 404, EXPIRED_MESSAGE)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(result))
  }
}
