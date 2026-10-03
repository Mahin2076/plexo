import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, makeDirs, PlexoApp, LAN_ADDRESS } from './fixtures'
import { sha256 } from './origin'
import { callPeer, hash } from '../src/main/together/transport'
import type { TogetherLease } from '../src/shared/together'

const MiB = 1024 * 1024

test('Together: Gemma chooses the helper, then failure reassigns and assembles the exact file', async ({
  plexo,
  serve
}) => {
  let modelRequests = 0
  const model = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part.toString()
    const prompt = JSON.parse(body)
    const devices = JSON.parse(prompt.messages[1].content) as { id: string }[]
    modelRequests++
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        message: {
          content: JSON.stringify({ priority: devices.map((device) => device.id).reverse() })
        }
      })
    )
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
  try {
    await plexo.evaluateMain(
      (_electron, endpoint) => {
        process.env.PLEXO_OLLAMA_URL = endpoint
      },
      `http://127.0.0.1:${(model.address() as AddressInfo).port}`
    )
    const origin = await serve({ size: 3 * MiB, bytesPerSecond: MiB / 2 })
    const code = await host(plexo, origin.url())
    const a = await callPeer<{ peer: string }>(code, '/join', { name: 'Phone A' })
    const b = await callPeer<{ peer: string }>(code, '/join', { name: 'Phone B' })
    const headersA = { 'X-Plexo-Peer': a.peer }
    const headersB = { 'X-Plexo-Peer': b.peer }
    await callPeer(code, '/lease', { remaining: 10 * MiB }, undefined, headersA)
    await callPeer(code, '/lease', { remaining: 10 * MiB }, undefined, headersB)
    await plexo.api.startTogether()
    await expect
      .poll(async () => (await plexo.api.getTogether())?.scheduler?.mode, {
        intervals: [20],
        timeout: 1000
      })
      .toBe('gemma')
    const refused = await callPeer<{ lease: TogetherLease | null }>(
      code,
      '/lease',
      { remaining: 10 * MiB },
      undefined,
      headersA
    )
    expect(refused.lease).toBeNull()
    const chosen = await callPeer<{ lease: TogetherLease }>(
      code,
      '/lease',
      { remaining: 10 * MiB },
      undefined,
      headersB
    )
    expect(chosen.lease).toBeTruthy()
    await plexo.page.getByRole('button', { name: 'Download Together', exact: true }).click()
    await expect(plexo.page.getByTestId('together-scheduler')).toContainText('Gemma scheduling')
    await callPeer(code, '/failed', { id: chosen.lease.id }, undefined, headersB)
    const replacement = await callPeer<{ lease: TogetherLease }>(
      code,
      '/lease',
      { remaining: 10 * MiB },
      undefined,
      headersA
    )
    expect(replacement.lease.index).toBe(chosen.lease.index)
    expect(replacement.lease.id).not.toBe(chosen.lease.id)
    const bytes = origin.content.subarray(replacement.lease.start, replacement.lease.end + 1)
    await callPeer(code, '/chunk', bytes, undefined, {
      ...headersA,
      'X-Plexo-Lease': replacement.lease.id,
      'X-Plexo-Sha256': hash(bytes)
    })
    await callPeer(code, '/leave', {}, undefined, headersA)
    await callPeer(code, '/leave', {}, undefined, headersB)
    await finalFile(plexo, sha256(origin.content))
    expect(modelRequests).toBeGreaterThan(0)
    expect((await plexo.api.getTogether())!.peers[0].bytes).toBe(MiB)
  } finally {
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
  }
})

async function host(plexo: PlexoApp, url: string, expectedSha256?: string): Promise<string> {
  const state = await plexo.api.hostTogether({
    url,
    destinationDir: plexo.dirs.dest,
    internetInterfaceId: 'a',
    lanAddress: '127.0.0.1',
    expectedSha256
  })
  return state.code!
}

async function finalFile(plexo: PlexoApp, expected: string): Promise<void> {
  await expect
    .poll(async () => (await plexo.api.getTogether())?.status, { timeout: 65_000 })
    .toBe('completed')
  const state = (await plexo.api.getTogether())!
  expect(sha256(await readFile(state.destinationPath!))).toBe(expected)
  expect(state.sha256).toBe(expected)
  expect(state.bytes).toBe(state.file.totalBytes)
  expect((await readdir(plexo.dirs.dest)).filter((name) => name.endsWith('.plexo'))).toEqual([])
}

test('Together: two Electron windows host, review, join and produce the exact file @smoke', async ({
  plexo,
  serve
}, testInfo) => {
  const origin = await serve({ size: 6 * MiB + 321, bytesPerSecond: 2 * MiB })
  const other = await makeDirs()
  const helper = new PlexoApp(other.dirs)
  try {
    await helper.launch()
    await plexo.page.getByRole('button', { name: 'Download Together', exact: true }).click()
    await plexo.page.getByLabel('Public download link').fill(origin.url())
    await plexo.page.getByLabel('Local address for friends to join').selectOption('127.0.0.1')
    await plexo.page.getByLabel('Publisher SHA-256 (optional)').fill(sha256(origin.content))
    // The UI destination defaults to Downloads; use the real folder picker bridge to set the test folder.
    await plexo.evaluateMain(({ dialog }, dest) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dest] })
    }, plexo.dirs.dest)
    await plexo.page.getByRole('button', { name: 'Browse…' }).click()
    await plexo.page.getByRole('button', { name: 'Create session' }).click()
    await expect(plexo.page.getByTestId('together-status')).toHaveText('waiting')
    const code = await plexo.page.getByLabel('Host join code').inputValue()
    await helper.page.getByRole('button', { name: 'Download Together', exact: true }).click()
    await helper.page.getByRole('button', { name: 'Join', exact: true }).click()
    await helper.page.getByLabel('Join code', { exact: true }).fill(code)
    await helper.page.getByRole('button', { name: 'Review file' }).click()
    await expect(helper.page.getByText(`Source: ${origin.url()}`)).toBeVisible()
    if (LAN_ADDRESS) await helper.page.getByLabel('Internet connection').selectOption('b')
    await helper.page.getByLabel('Your name').fill('Test friend')
    await helper.page.getByRole('button', { name: 'Join and help' }).click()
    await expect(helper.page.getByTestId('together-status')).toHaveText('waiting')
    await plexo.page.getByRole('button', { name: 'Start together' }).click()
    await finalFile(plexo, sha256(origin.content))
    await expect.poll(async () => (await helper.api.getTogether())?.status).toBe('completed')
    const state = (await plexo.api.getTogether())!
    expect(state.contributedBytes).toBeGreaterThan(0)
    expect(state.peers[0].bytes).toBeGreaterThan(0)
    expect(state.contributedBytes + state.peers[0].bytes).toBe(state.file.totalBytes)
    expect((await helper.api.getTogether())!.contributedBytes).toBe(state.peers[0].bytes)
    if (LAN_ADDRESS)
      expect(origin.log.some((entry) => entry.from === LAN_ADDRESS && entry.bytesSent > 1)).toBe(
        true
      )
    await plexo.page.screenshot({ path: testInfo.outputPath('together-completed.png') })
  } finally {
    if (helper.alive) await helper.quit()
    await other.dispose()
  }
})

test('Together: helper payload budget stops work and host finishes', async ({ plexo, serve }) => {
  const origin = await serve({ size: 5 * MiB, bytesPerSecond: MiB })
  const code = await host(plexo, origin.url())
  const other = await makeDirs()
  const helper = new PlexoApp(other.dirs)
  try {
    await helper.launch()
    const file = await helper.api.previewTogether(code)
    await helper.api.joinTogether({
      code,
      file,
      name: 'Budget helper',
      internetInterfaceId: 'a',
      budgetBytes: MiB
    })
    await plexo.api.startTogether()
    await expect
      .poll(async () => (await helper.api.getTogether())?.status, { timeout: 15_000 })
      .toBe('stopped')
    const contribution = (await helper.api.getTogether())!
    expect(contribution.usedBytes).toBe(MiB)
    expect(contribution.contributedBytes).toBe(MiB)
    await finalFile(plexo, sha256(origin.content))
  } finally {
    if (helper.alive) await helper.quit()
    await other.dispose()
  }
})

test('Together: leaving during a chunk reassigns it to the host', async ({ plexo, serve }) => {
  const origin = await serve({ size: 4 * MiB, bytesPerSecond: MiB })
  const code = await host(plexo, origin.url())
  const other = await makeDirs()
  const helper = new PlexoApp(other.dirs)
  try {
    await helper.launch()
    await helper.api.joinTogether({
      code,
      file: await helper.api.previewTogether(code),
      name: 'Leaving',
      internetInterfaceId: 'a',
      budgetBytes: 10 * MiB
    })
    await plexo.api.startTogether()
    await expect
      .poll(async () => (await helper.api.getTogether())?.usedBytes ?? 0)
      .toBeGreaterThan(0)
    await helper.api.stopTogether()
    await finalFile(plexo, sha256(origin.content))
    expect((await plexo.api.getTogether())!.peers[0].status).toBe('left')
    expect((await helper.api.getTogether())!.status).toBe('stopped')
  } finally {
    if (helper.alive) await helper.quit()
    await other.dispose()
  }
})

test('Together: an abandoned lease expires and the host finishes', async ({ plexo, serve }) => {
  test.setTimeout(80_000)
  const origin = await serve({ size: 3 * MiB, bytesPerSecond: MiB })
  const code = await host(plexo, origin.url())
  const { peer } = await callPeer<{ peer: string }>(code, '/join', { name: 'Disconnected' })
  await plexo.api.startTogether()
  const assignment = await callPeer<{ lease: TogetherLease }>(
    code,
    '/lease',
    { remaining: 10 * MiB },
    undefined,
    { 'X-Plexo-Peer': peer }
  )
  expect(assignment.lease).toBeTruthy()
  // Simulate a killed helper: no upload, no leave request, no more traffic.
  await finalFile(plexo, sha256(origin.content))
  expect((await plexo.api.getTogether())!.peers[0].bytes).toBe(0)
})

test('Together: wrong publisher checksum refuses publication and removes staging file', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: MiB })
  await host(plexo, origin.url(), '0'.repeat(64))
  await plexo.api.startTogether()
  await expect.poll(async () => (await plexo.api.getTogether())?.status).toBe('error')
  await expect.poll(() => readdir(plexo.dirs.dest)).toEqual([])
  expect((await plexo.api.getTogether())!.error).toContain('SHA-256')
})

test('Together: reject strangers, browser origins, malformed chunks and duplicate uploads', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: 4 * MiB, bytesPerSecond: MiB })
  const code = await host(plexo, origin.url())
  await expect(
    callPeer(code.slice(0, -1) + (code.endsWith('0') ? '1' : '0'), '/session')
  ).rejects.toThrow('Invalid session code')
  await expect(
    callPeer(code, '/session', undefined, undefined, { Origin: 'https://untrusted.example' })
  ).rejects.toThrow('Invalid session code')
  const { peer } = await callPeer<{ peer: string }>(code, '/join', { name: 'Helper' })
  await plexo.api.startTogether()
  const headers = { 'X-Plexo-Peer': peer }
  const { lease } = await callPeer<{ lease: TogetherLease }>(
    code,
    '/lease',
    { remaining: 10 * MiB },
    undefined,
    headers
  )
  const bytes = origin.content.subarray(lease.start, lease.end + 1)
  const upload = { ...headers, 'X-Plexo-Lease': lease.id, 'X-Plexo-Sha256': hash(bytes) }
  await expect(callPeer(code, '/chunk', Buffer.alloc(1), undefined, upload)).rejects.toThrow(
    'Incorrect chunk size'
  )
  await expect(
    callPeer(code, '/chunk', bytes, undefined, { ...upload, 'X-Plexo-Sha256': '0'.repeat(64) })
  ).rejects.toThrow('checksum mismatch')
  await callPeer(code, '/chunk', bytes, undefined, upload)
  await expect(callPeer(code, '/chunk', bytes, undefined, upload)).rejects.toThrow(
    'no longer needed'
  )
  await finalFile(plexo, sha256(origin.content))
})

test('Together: stop cleans staging data, revokes code and allows a fresh session', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: 3 * MiB, bytesPerSecond: MiB })
  const code = await host(plexo, origin.url())
  await plexo.api.startTogether()
  await plexo.api.stopTogether()
  expect((await plexo.api.getTogether())!.status).toBe('stopped')
  expect(await readdir(plexo.dirs.dest)).toEqual([])
  await expect(callPeer(code, '/session')).rejects.toThrow()
  await host(plexo, origin.url())
  await plexo.api.startTogether()
  await finalFile(plexo, sha256(origin.content))
})

test('Together: unsupported sources do not create files', async ({ plexo, serve }) => {
  for (const options of [{ ranges: false }, { etag: null }, { etag: 'W/"weak"' }]) {
    const origin = await serve({ size: MiB, ...options })
    await expect(host(plexo, origin.url())).rejects.toThrow('Together needs')
    expect(await readdir(plexo.dirs.dest)).toEqual([])
  }
})

test('Together: a changed source cannot be mixed into the saved file', async ({ plexo, serve }) => {
  const origin = await serve({ size: 2 * MiB })
  await host(plexo, origin.url())
  origin.etag = '"changed-version"'
  await plexo.api.startTogether()
  await expect.poll(async () => (await plexo.api.getTogether())?.status).toBe('error')
  expect((await plexo.api.getTogether())!.error).toContain('source changed')
  await expect.poll(() => readdir(plexo.dirs.dest)).toEqual([])
})

test('Together: quitting an active host removes its unfinished file', async ({ plexo, serve }) => {
  const origin = await serve({ size: 4 * MiB, bytesPerSecond: MiB })
  const code = await host(plexo, origin.url())
  await plexo.api.startTogether()
  await plexo.quit()
  expect(await readdir(plexo.dirs.dest)).toEqual([])
  await expect(callPeer(code, '/session')).rejects.toThrow()
})

test('Together: failed phone chunk moves to another helper and stale messages cannot overwrite it', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: 4 * MiB + 123, bytesPerSecond: MiB })
  const code = await host(plexo, origin.url())
  const first = await callPeer<{ peer: string }>(code, '/join', { name: 'Phone A' })
  const second = await callPeer<{ peer: string }>(code, '/join', { name: 'Phone B' })
  const a = { 'X-Plexo-Peer': first.peer }
  const b = { 'X-Plexo-Peer': second.peer }
  await plexo.api.startTogether()
  const { lease } = await callPeer<{ lease: TogetherLease }>(
    code,
    '/lease',
    { remaining: 10 * MiB },
    undefined,
    a
  )
  expect(lease).toBeTruthy()
  // Another participant cannot release this phone's assignment.
  await callPeer(code, '/failed', { id: lease.id }, undefined, b)
  const unchanged = await callPeer<{ lease: TogetherLease }>(
    code,
    '/lease',
    { remaining: 10 * MiB },
    undefined,
    a
  )
  expect(unchanged.lease.id).toBe(lease.id)
  await callPeer(code, '/failed', { id: lease.id }, undefined, a)
  const cooling = await callPeer<{ lease: TogetherLease | null }>(
    code,
    '/lease',
    { remaining: 10 * MiB },
    undefined,
    a
  )
  expect(cooling.lease).toBeNull()
  const replacement = await callPeer<{ lease: TogetherLease }>(
    code,
    '/lease',
    { remaining: 10 * MiB },
    undefined,
    b
  )
  expect(replacement.lease.index).toBe(lease.index)
  expect(replacement.lease.id).not.toBe(lease.id)
  await callPeer(code, '/failed', { id: lease.id }, undefined, a)
  const bytes = origin.content.subarray(lease.start, lease.end + 1)
  await expect(
    callPeer(code, '/chunk', bytes, undefined, {
      ...a,
      'X-Plexo-Lease': lease.id,
      'X-Plexo-Sha256': hash(bytes)
    })
  ).rejects.toThrow('no longer needed')
  await callPeer(code, '/chunk', bytes, undefined, {
    ...b,
    'X-Plexo-Lease': replacement.lease.id,
    'X-Plexo-Sha256': hash(bytes)
  })
  await finalFile(plexo, sha256(origin.content))
  const state = (await plexo.api.getTogether())!
  expect(state.peers[0].bytes).toBe(0)
  expect(state.peers[1].bytes).toBe(bytes.length)
})

test('Together: helper survives a transient source failure and host recovers its chunk', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: 4 * MiB, bytesPerSecond: MiB })
  const code = await host(plexo, origin.url())
  let injected = false
  // Host claims chunk zero synchronously on start. Fail the helper's first range once.
  origin.setRule((request) => {
    if (!injected && request.range?.start === MiB) {
      injected = true
      return { cutAfter: 16 * 1024 }
    }
    return 'ok'
  })
  const other = await makeDirs()
  const helper = new PlexoApp(other.dirs)
  try {
    await helper.launch()
    await helper.api.joinTogether({
      code,
      file: await helper.api.previewTogether(code),
      name: 'Recovering helper',
      internetInterfaceId: 'a',
      budgetBytes: 10 * MiB
    })
    await plexo.api.startTogether()
    await expect
      .poll(async () => (await helper.api.getTogether())?.usedBytes ?? 0)
      .toBeGreaterThan(0)
    await finalFile(plexo, sha256(origin.content))
    expect(injected).toBe(true)
    await expect.poll(async () => (await helper.api.getTogether())?.status).toBe('completed')
    expect((await helper.api.getTogether())!.usedBytes).toBe(16 * 1024)
    expect(origin.log.filter((entry) => entry.range?.start === MiB).length).toBeGreaterThan(1)
  } finally {
    if (helper.alive) await helper.quit()
    await other.dispose()
  }
})
