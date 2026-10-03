import { test, expect } from '@playwright/test'
import { ChunkScheduler } from '../src/main/together/scheduler'

const devices = [
  { id: 'host', bytesPerSecond: 1000, failures: 0, remainingBytes: 10000 },
  { id: 'secret-peer-token', bytesPerSecond: 500, failures: 1, remainingBytes: 2000 }
]

function responder(priority: unknown): typeof fetch {
  return async (_url, options) => {
    const body = String(options?.body)
    expect(body).not.toContain('secret-peer-token')
    expect(JSON.parse(body).model).toBe('gemma4:e2b')
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ priority }) } }))
  }
}

test('Gemma priorities override speed order without exposing peer credentials', async () => {
  const scheduler = new ChunkScheduler(
    'http://127.0.0.1:11434',
    'gemma4:e2b',
    responder(['device-1', 'device-0'])
  )
  const signal = new AbortController().signal
  expect(scheduler.rank(devices, signal)).toEqual(['host', 'secret-peer-token'])
  await expect.poll(() => scheduler.status.mode).toBe('gemma')
  expect(scheduler.rank(devices, signal)).toEqual(['secret-peer-token', 'host'])
})

for (const priority of [['device-0', 'device-0'], ['unknown', 'device-0'], ['device-1'], null]) {
  test(`Invalid priorities fall back: ${JSON.stringify(priority)}`, async () => {
    const scheduler = new ChunkScheduler(
      'http://localhost:11434',
      'gemma4:e2b',
      responder(priority)
    )
    const signal = new AbortController().signal
    scheduler.rank(devices, signal)
    await expect.poll(() => scheduler.status.detail).toContain('invalid response')
    expect(scheduler.rank(devices, signal)).toEqual(['host', 'secret-peer-token'])
    expect(scheduler.status.mode).toBe('fallback')
  })
}

test('A stale model result cannot restore a departed device', async () => {
  let respond!: (response: Response) => void
  const scheduler = new ChunkScheduler(
    'http://localhost:11434',
    'gemma4:e2b',
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve
      })
  )
  const signal = new AbortController().signal
  scheduler.rank(devices, signal)
  expect(scheduler.rank([devices[0]], signal)).toEqual(['host'])
  respond(
    new Response(JSON.stringify({ message: { content: '{"priority":["device-1","device-0"]}' } }))
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(scheduler.rank([devices[0]], signal)).toEqual(['host'])
  expect(scheduler.status.mode).toBe('fallback')
})

test('Unavailable model does not block assignment and retries are bounded', async () => {
  let requests = 0
  const scheduler = new ChunkScheduler('http://localhost:11434', 'gemma4:e2b', async () => {
    requests++
    throw new Error('offline')
  })
  const signal = new AbortController().signal
  expect(scheduler.rank(devices, signal)).toEqual(['host', 'secret-peer-token'])
  await expect.poll(() => scheduler.status.detail).toContain('unavailable')
  for (let index = 0; index < 100; index++) scheduler.rank(devices, signal)
  expect(requests).toBe(1)
})

test('Canceled session ignores an in-flight model decision', async () => {
  const controller = new AbortController()
  const scheduler = new ChunkScheduler(
    'http://localhost:11434',
    'gemma4:e2b',
    responder(['device-1', 'device-0'])
  )
  scheduler.rank(devices, controller.signal)
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(scheduler.status.mode).toBe('fallback')
})
