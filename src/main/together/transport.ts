import { createHash } from 'node:crypto'
import { request, type IncomingMessage } from 'node:http'
import { isIPv4 } from 'node:net'
import type { TogetherFile, TogetherLease } from '../../shared/together'
import type { NetworkInterfaceInfo } from '../../shared/types'
import { StreamConnection } from '../network/routes'

export const CHUNK_BYTES = 1024 * 1024
export const LEASE_MS = 45_000
export const TRANSFER_MS = 30_000
export const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export function lanAddress(address: string): boolean {
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  )
}

export function parseCode(code: string): { host: string; port: number; token: string } {
  if (typeof code !== 'string' || code.length > 256) throw new Error('Invalid join code')
  const match = /^plexo:\/\/([\d.]+):(\d+)\/([a-f0-9]{32})$/.exec(code.trim())
  if (!match || !lanAddress(match[1]) || +match[2] < 1 || +match[2] > 65535) {
    throw new Error('Paste the complete Plexo join code from the host on your local network')
  }
  return { host: match[1], port: +match[2], token: match[3] }
}

export async function readBody(message: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let length = 0
  for await (const raw of message) {
    const part = Buffer.from(raw)
    length += part.length
    if (length > limit) throw new Error('Request exceeds the allowed size')
    parts.push(part)
  }
  return Buffer.concat(parts, length)
}

/** No redirects, cookies, proxy or browser credentials are forwarded to a peer. */
export function callPeer<T>(
  code: string,
  path: string,
  data?: object | Buffer,
  signal?: AbortSignal,
  extra: Record<string, string> = {}
): Promise<T> {
  const { host, port, token } = parseCode(code)
  const body =
    data === undefined
      ? undefined
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(JSON.stringify(data))
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        path,
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.any([AbortSignal.timeout(TRANSFER_MS), ...(signal ? [signal] : [])]),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Length': String(body?.length ?? 0),
          ...extra
        }
      },
      (res) => {
        void readBody(res, 32 * 1024)
          .then((bytes) => {
            const value = JSON.parse(bytes.toString())
            if (res.statusCode !== 200)
              throw new Error(
                typeof value.error === 'string' ? value.error : 'The host refused the request'
              )
            resolve(value as T)
          })
          .catch(reject)
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

export function validateFile(value: TogetherFile): TogetherFile {
  if (
    !value ||
    value.protocol !== 1 ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.url !== 'string' ||
    value.url.length > 8192 ||
    typeof value.fileName !== 'string' ||
    value.fileName.length > 1024 ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 1 ||
    value.totalBytes > CHUNK_BYTES * 100_000 ||
    typeof value.etag !== 'string' ||
    !/^"[^\r\n]*"$/.test(value.etag)
  ) {
    throw new Error('This session has unsupported file metadata')
  }
  const url = new URL(value.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP(S) links without embedded credentials are supported')
  if (value.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(value.expectedSha256))
    throw new Error('Invalid SHA-256 checksum')
  return value
}

/** One bounded range; exact ETag/range/length checks. A redirect requires a fresh session. */
export async function fetchPiece(
  file: TogetherFile,
  lease: TogetherLease,
  network: () => NetworkInterfaceInfo | undefined,
  signal: AbortSignal,
  progress: (bytes: number) => void
): Promise<Buffer> {
  const length = lease.end - lease.start + 1
  if (
    !Number.isSafeInteger(lease.start) ||
    !Number.isSafeInteger(lease.end) ||
    lease.start < 0 ||
    lease.end >= file.totalBytes ||
    length < 1 ||
    length > CHUNK_BYTES
  )
    throw new Error('Invalid chunk assignment')
  const connection = new StreamConnection(network, { timeoutMs: TRANSFER_MS })
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_MS)])
  const abort = (): void => connection.close()
  deadline.addEventListener('abort', abort, { once: true })
  try {
    const { res: response } = await connection.request(
      new URL(file.url),
      {
        Range: `bytes=${lease.start}-${lease.end}`,
        'If-Match': file.etag,
        'Accept-Encoding': 'identity',
        'User-Agent': 'Plexo-Together/1'
      },
      deadline
    )
    if (
      response.statusCode !== 206 ||
      response.headers['content-range'] !==
        `bytes ${lease.start}-${lease.end}/${file.totalBytes}` ||
      response.headers.etag !== file.etag ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
    ) {
      response.destroy()
      throw new Error('The source changed or did not return the requested file range')
    }
    const parts: Buffer[] = []
    let received = 0
    for await (const raw of response) {
      const part = Buffer.from(raw)
      received += part.length
      progress(part.length)
      if (received > length) throw new Error('Source sent too many bytes')
      parts.push(part)
    }
    if (received !== length) throw new Error('Source returned an incomplete chunk')
    return Buffer.concat(parts, received)
  } finally {
    deadline.removeEventListener('abort', abort)
    connection.close()
  }
}
