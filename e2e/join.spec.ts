import type { Page } from '@playwright/test'
import type { JoinState, JoinedDevice } from '../src/shared/types'
import { expect, NETWORKS, test, type PlexoApp } from './fixtures'

// M. Joining a phone: the link the QR code carries, the small HTTP API the phone's page talks
// to, and what the window learns from it. The API-level tests play the phone with fetch; the
// journey at the end runs the real page in a second window.

const JOIN_ENV = { PLEXO_E2E_JOIN_HOST: '127.0.0.1', PLEXO_E2E_SPEEDTEST_ORIGIN: 'self' }
const MIB = 1024 * 1024
const KIB = 1024
/** The most a single measurement transfer may be, and the most a JSON body may be. */
const TRANSFER_LIMIT = 64 * MIB
const JSON_LIMIT = 64 * KIB

interface ReportBody {
  internetLatencyMs: number | null
  internetDownloadBps: number | null
  internetUploadBps: number | null
  linkLatencyMs: number
  linkDownloadBps: number
  linkUploadBps: number
  durationMs: number
  connectionType?: string
}

const REPORT: ReportBody = {
  internetLatencyMs: 23.5,
  internetDownloadBps: 12_500_000,
  internetUploadBps: 2_000_000,
  linkLatencyMs: 4,
  linkDownloadBps: 50_000_000,
  linkUploadBps: 40_000_000,
  durationMs: 9000,
  connectionType: '4g'
}
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

// --- helpers ----------------------------------------------------------------------------------

/** Every join state the window is pushed, in order. */
async function recordJoinStates(plexo: PlexoApp): Promise<JoinState[]> {
  const states: JoinState[] = []
  await plexo.page.exposeFunction('__plexoJoinRecord', (state: JoinState) => states.push(state))
  await plexo.page.evaluate(() => {
    const w = window as unknown as { __plexoJoinRecord: (s: unknown) => void }
    window.plexo.onJoinStateChanged((state) => w.__plexoJoinRecord(state))
  })
  return states
}

/** The phone's side of a session: where to call, with which token. */
class Phone {
  constructor(
    readonly origin: string,
    readonly token: string
  ) {}

  static fromState(state: JoinState): Phone {
    expect(state.session, 'a session is open').not.toBeNull()
    const url = new URL(state.session!.urls[0].url)
    return new Phone(url.origin, url.searchParams.get('t')!)
  }

  url(
    path: string,
    params: Record<string, string> = {},
    token: string | null = this.token
  ): string {
    const url = new URL(path, this.origin)
    if (token !== null) url.searchParams.set('t', token)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url.href
  }

  page(token?: string | null): Promise<Response> {
    return fetch(this.url('/join', {}, token))
  }

  ping(token?: string | null): Promise<Response> {
    return fetch(this.url('/api/join/ping', {}, token))
  }

  down(bytes: string, token?: string | null): Promise<Response> {
    return fetch(this.url('/api/join/down', { bytes }, token))
  }

  up(body: ArrayBuffer, token?: string | null): Promise<Response> {
    return fetch(this.url('/api/join/up', {}, token), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body
    })
  }

  progress(body: unknown, token?: string | null): Promise<Response> {
    return this.postJson('/api/join/progress', body, {}, token)
  }

  report(body: unknown, userAgent = IPHONE_UA, token?: string | null): Promise<Response> {
    return this.postJson('/api/join/report', body, { 'user-agent': userAgent }, token)
  }

  private postJson(
    path: string,
    body: unknown,
    headers: Record<string, string>,
    token?: string | null
  ): Promise<Response> {
    return fetch(this.url(path, {}, token), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  }
}

/** A link that has been retired: refused with a 404 while the server is still up, or nothing
 * listening at all once the server has been stopped with the session. */
async function expectDead(request: () => Promise<Response>, label: string): Promise<void> {
  const outcome = await request().catch((error: Error) => error)
  if (outcome instanceof Error) {
    expect(outcome.message, label).toMatch(/fetch failed/)
    return
  }
  expect(outcome.status, label).toBe(404)
  await outcome.text()
}

async function openSession(plexo: PlexoApp): Promise<Phone> {
  return Phone.fromState(await plexo.api.startJoinSession())
}

/** A second, sandboxed window — a browser with no preload and no node, which is what a phone's
 * is — not yet pointed anywhere, so a test can shape its network (page.route) before it loads. */
async function openPhoneWindow(plexo: PlexoApp): Promise<Page> {
  const opened = plexo.electronApp.waitForEvent('window')
  await plexo.evaluateMain(({ BrowserWindow }) => {
    const w = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Hidden windows throttle timers; the phone's page isn't hidden on a real phone.
        backgroundThrottling: false
      }
    })
    // No renderer — so nothing for Playwright to attach to — until the window loads something.
    void w.loadURL('about:blank')
  }, null)
  return opened
}

const device = (state: JoinState): JoinedDevice => {
  expect(state.devices, 'one joined device').toHaveLength(1)
  return state.devices[0]
}

const capabilityOf = (report: ReportBody): Partial<JoinedDevice['capability']> => ({
  internetLatencyMs: report.internetLatencyMs,
  internetDownloadBps: report.internetDownloadBps,
  internetUploadBps: report.internetUploadBps,
  linkLatencyMs: report.linkLatencyMs,
  linkDownloadBps: report.linkDownloadBps,
  linkUploadBps: report.linkUploadBps,
  durationMs: report.durationMs
})

// --- the API, played by fetch -----------------------------------------------------------------

test.describe('join @smoke', () => {
  test.use({ appEnv: JOIN_ENV })

  test('nothing is open until asked', async ({ plexo }) => {
    expect(await plexo.api.getJoinState()).toEqual({ session: null, devices: [] })
  })

  test('starting a session mints a link per network, serves the page there, and tells the window', async ({
    plexo
  }) => {
    const states = await recordJoinStates(plexo)
    const before = Date.now()
    const state = await plexo.api.startJoinSession()

    const session = state.session!
    expect(session.status).toBe('waiting')
    expect(session.id).toEqual(expect.any(String))
    expect(session.createdAt).toBeGreaterThanOrEqual(before)
    expect(session.expiresAt).toBeGreaterThan(session.createdAt)
    expect(state.devices).toEqual([])
    expect(session.urls).toHaveLength(Object.keys(NETWORKS).length)
    expect(session.urls[0]).toMatchObject({ interfaceId: 'a', label: 'a' })
    expect(session.urls[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/join\?t=[A-Za-z0-9_-]+$/)
    expect(await plexo.api.getJoinState()).toEqual(state)
    await expect.poll(() => states.at(-1)?.session?.status, 'the window was told').toBe('waiting')

    const phone = Phone.fromState(state)
    const res = await phone.page()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(res.headers.get('content-security-policy')).toMatch(/'nonce-[A-Za-z0-9+/=_-]+'/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toContain('<title>Join Plexo</title>')
  })

  test('a missing, wrong or retired token is refused with a 404 on every path', async ({
    plexo
  }) => {
    const phone = await openSession(plexo)
    const refused = async (res: Promise<Response>, label: string): Promise<void> => {
      const r = await res
      expect(r.status, label).toBe(404)
      expect(r.headers.get('content-type'), label).toMatch(/^text\/plain/)
      await r.text()
    }
    await refused(phone.page(null), 'page without a token')
    await refused(phone.page('nope'), 'page with a wrong token')
    await refused(phone.ping('nope'), 'ping')
    await refused(phone.down('1000', 'nope'), 'down')
    await refused(phone.up(new ArrayBuffer(10), 'nope'), 'up')
    await refused(phone.progress({ phase: 'latency' }, 'nope'), 'progress')
    await refused(phone.report(REPORT, IPHONE_UA, 'nope'), 'report')
    // Nothing the wrong token did changed anything.
    expect((await plexo.api.getJoinState()).session?.status).toBe('waiting')

    await plexo.api.stopJoinSession()
    expect((await plexo.api.getJoinState()).session).toBeNull()
    await expectDead(() => phone.page(), 'page after stopping')
    await expectDead(() => phone.ping(), 'ping after stopping')
  })

  test('starting again retires the first link', async ({ plexo }) => {
    const first = await openSession(plexo)
    const second = await openSession(plexo)
    expect(second.token).not.toBe(first.token)
    expect((await first.ping()).status).toBe(404)
    expect((await second.ping()).status).toBe(204)
    expect((await plexo.api.getJoinState()).session?.urls[0].url).toContain(second.token)
  })

  test('ping, down and up are the link measurement endpoints', async ({ plexo }) => {
    const phone = await openSession(plexo)

    const ping = await phone.ping()
    expect(ping.status).toBe(204)

    const down = await phone.down(String(MIB))
    expect(down.status).toBe(200)
    expect(down.headers.get('content-type')).toMatch(/^application\/octet-stream/)
    expect(down.headers.get('content-length')).toBe(String(MIB))
    expect((await down.arrayBuffer()).byteLength).toBe(MIB)

    const small = await phone.down('1000')
    expect(small.status).toBe(200)
    expect((await small.arrayBuffer()).byteLength).toBe(1000)

    for (const bytes of [String(TRANSFER_LIMIT + 1), '1.5', 'abc', '']) {
      const res = await phone.down(bytes)
      expect(res.status, `bytes=${bytes}`).toBe(400)
      await res.text()
    }

    expect((await phone.up(new ArrayBuffer(MIB))).status).toBe(204)
    expect((await phone.up(new ArrayBuffer(0))).status).toBe(204)
    const tooBig = await phone.up(new ArrayBuffer(TRANSFER_LIMIT + 1))
    expect(tooBig.status).toBe(413)
    await tooBig.text()

    // Measuring on its own doesn't move the session along: only progress and report do.
    expect((await plexo.api.getJoinState()).session?.status).toBe('waiting')
  })

  test('progress moves the session to testing and says which phase', async ({ plexo }) => {
    const states = await recordJoinStates(plexo)
    const phone = await openSession(plexo)

    expect((await phone.progress({ phase: 'latency' })).status).toBe(204)
    expect((await plexo.api.getJoinState()).session).toMatchObject({
      status: 'testing',
      phase: 'latency'
    })
    await expect.poll(() => states.at(-1)?.session?.phase).toBe('latency')

    expect((await phone.progress({ phase: 'download' })).status).toBe(204)
    await expect.poll(() => states.at(-1)?.session?.phase).toBe('download')
    expect((await phone.progress({ phase: 'upload' })).status).toBe(204)
    await expect.poll(() => states.at(-1)?.session?.phase).toBe('upload')
    expect(states.at(-1)?.session?.status).toBe('testing')

    for (const body of [{ phase: 'teleport' }, { phase: 7 }, {}, 'not json', '[]']) {
      const res = await phone.progress(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      await res.text()
    }
    expect((await plexo.api.getJoinState()).session).toMatchObject({
      status: 'testing',
      phase: 'upload'
    })
  })

  test('a report makes a joined device, named from the browser that sent it', async ({ plexo }) => {
    const states = await recordJoinStates(plexo)
    const phone = await openSession(plexo)
    await phone.progress({ phase: 'upload' })

    const before = Date.now()
    const res = await phone.report(REPORT, IPHONE_UA)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    const answer = (await res.json()) as { deviceId: string; name: string }
    expect(answer).toEqual({ deviceId: expect.any(String), name: 'iPhone' })

    const state = await plexo.api.getJoinState()
    expect(state.session).toMatchObject({ status: 'done', deviceId: answer.deviceId })
    expect(state.session?.error).toBeUndefined()
    const joined = device(state)
    expect(joined).toMatchObject({
      id: answer.deviceId,
      name: 'iPhone',
      platform: 'ios',
      connectionType: '4g',
      address: '127.0.0.1',
      viaInterfaceId: 'a',
      capability: capabilityOf(REPORT)
    })
    expect(joined.capability.measuredAt).toBeGreaterThanOrEqual(before)
    expect(joined.capability.measuredAt).toBeLessThanOrEqual(Date.now())
    expect(joined.joinedAt).toBeGreaterThanOrEqual(before)
    await expect.poll(() => states.at(-1)?.session?.status).toBe('done')
    expect(states.at(-1)?.devices).toEqual([joined])
  })

  test('an Android browser, and one that is neither, are named too', async ({ plexo }) => {
    const android = await openSession(plexo)
    const first = (await (await android.report(REPORT, ANDROID_UA)).json()) as { name: string }
    expect(first.name).toBe('Android phone')

    const other = await openSession(plexo)
    const second = (await (await other.report(REPORT, 'curl/8.0')).json()) as { name: string }
    expect(second.name).toBe('Phone')

    const { devices } = await plexo.api.getJoinState()
    expect(devices.map((d) => [d.name, d.platform])).toEqual([
      ['Android phone', 'android'],
      ['Phone', 'other']
    ])
  })

  test('a second report on the same session replaces the device’s figures', async ({ plexo }) => {
    const phone = await openSession(plexo)
    const first = (await (await phone.report(REPORT)).json()) as { deviceId: string }

    const faster = { ...REPORT, linkDownloadBps: 90_000_000, internetLatencyMs: null }
    const res = await phone.report(faster)
    expect(res.status).toBe(200)
    const second = (await res.json()) as { deviceId: string }
    expect(second.deviceId).toBe(first.deviceId)

    const state = await plexo.api.getJoinState()
    expect(state.session).toMatchObject({ status: 'done', deviceId: first.deviceId })
    const joined = device(state)
    expect(joined.id).toBe(first.deviceId)
    expect(joined.capability).toMatchObject(capabilityOf(faster))
  })

  test('a report that doesn’t parse is refused and the session says so', async ({ plexo }) => {
    const states = await recordJoinStates(plexo)
    const phone = await openSession(plexo)
    await phone.progress({ phase: 'upload' })

    const bad: unknown[] = [
      { ...REPORT, linkDownloadBps: -1 },
      { ...REPORT, linkLatencyMs: null },
      { ...REPORT, connectionType: 'x'.repeat(33) },
      'not json',
      '[]'
    ]
    for (const body of bad) {
      const res = await phone.report(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      await res.text()
    }
    const state = await plexo.api.getJoinState()
    expect(state.session).toMatchObject({ status: 'testing', phase: 'upload' })
    expect(state.session?.error).toEqual(expect.any(String))
    expect(state.session?.error?.length).toBeGreaterThan(0)
    expect(state.devices).toEqual([])
    await expect.poll(() => states.at(-1)?.session?.error).toEqual(expect.any(String))

    // The phone can still get it right.
    expect((await phone.report(REPORT)).status).toBe(200)
    expect((await plexo.api.getJoinState()).session?.status).toBe('done')
  })

  test('a JSON body too big to be a report is refused before it is read', async ({ plexo }) => {
    const phone = await openSession(plexo)
    const padded = JSON.stringify({ ...REPORT, padding: 'x'.repeat(JSON_LIMIT) })
    expect(padded.length).toBeGreaterThan(JSON_LIMIT)
    const report = await phone.report(padded)
    expect(report.status).toBe(413)
    await report.text()
    const progress = await phone.progress(JSON.stringify({ phase: 'latency', padding: padded }))
    expect(progress.status).toBe(413)
    await progress.text()
    expect((await plexo.api.getJoinState()).session?.status).toBe('waiting')
  })

  test('unknown paths are 404 and wrong methods 405, token or not', async ({ plexo }) => {
    const phone = await openSession(plexo)
    const expectStatus = async (
      res: Promise<Response>,
      status: number,
      label: string
    ): Promise<void> => {
      const r = await res
      expect(r.status, label).toBe(status)
      await r.text()
    }
    await expectStatus(fetch(phone.url('/api/join/nothing')), 404, 'unknown api path')
    await expectStatus(fetch(phone.url('/somewhere')), 404, 'unknown path')
    await expectStatus(fetch(phone.url('/', {}, null)), 404, 'root')
    await expectStatus(fetch(phone.url('/api/join/report')), 405, 'GET report')
    await expectStatus(fetch(phone.url('/api/join/progress')), 405, 'GET progress')
    await expectStatus(fetch(phone.url('/api/join/ping'), { method: 'POST' }), 405, 'POST ping')
    await expectStatus(fetch(phone.url('/join'), { method: 'POST' }), 405, 'POST page')
    expect((await plexo.api.getJoinState()).session?.status).toBe('waiting')
  })

  test('stopping keeps the devices, removing drops one, and the window hears both', async ({
    plexo
  }) => {
    const states = await recordJoinStates(plexo)
    const phone = await openSession(plexo)
    const { deviceId } = (await (await phone.report(REPORT)).json()) as { deviceId: string }

    await plexo.api.stopJoinSession()
    let state = await plexo.api.getJoinState()
    expect(state.session).toBeNull()
    expect(device(state).id).toBe(deviceId)
    await expect.poll(() => states.at(-1)?.session).toBeNull()
    await expectDead(() => phone.page(), 'page after stopping')
    await expectDead(() => phone.report(REPORT), 'report after stopping')

    // Stopping twice is nothing.
    await plexo.api.stopJoinSession()
    expect((await plexo.api.getJoinState()).session).toBeNull()

    await plexo.api.removeJoinedDevice(deviceId)
    state = await plexo.api.getJoinState()
    expect(state).toEqual({ session: null, devices: [] })
    await expect.poll(() => states.at(-1)?.devices).toEqual([])

    // Removing a device that isn't there is nothing either.
    await plexo.api.removeJoinedDevice(deviceId)
    expect(await plexo.api.getJoinState()).toEqual({ session: null, devices: [] })
  })
})

// --- time, and the real page ------------------------------------------------------------------

test.describe('join', () => {
  test.describe('with a short link lifetime', () => {
    test.use({ appEnv: { ...JOIN_ENV, PLEXO_E2E_JOIN_TTL_MS: '400' } })

    test('a link nobody opens expires, and the window hears it', async ({ plexo }) => {
      const states = await recordJoinStates(plexo)
      const phone = await openSession(plexo)
      expect((await phone.ping()).status).toBe(204)

      await expect
        .poll(() => plexo.api.getJoinState().then((s) => s.session?.status), { timeout: 5000 })
        .toBe('expired')
      await expect.poll(() => states.at(-1)?.session?.status).toBe('expired')
      await expectDead(() => phone.ping(), 'ping after expiry')
      await expectDead(() => phone.page(), 'page after expiry')
      await expectDead(() => phone.report(REPORT), 'report after expiry')

      // A fresh link works for as long as it lasts.
      const again = await openSession(plexo)
      expect(again.token).not.toBe(phone.token)
      expect((await again.page()).status).toBe(200)
    })
  })

  test.describe('through the window and the phone’s page', () => {
    test.use({ appEnv: JOIN_ENV })

    test('scan, measure, join, see the phone, remove it', async ({ plexo }) => {
      const states = await recordJoinStates(plexo)
      const page = plexo.page
      await page.getByRole('button', { name: 'Join a phone' }).click()
      const dialog = page.getByRole('dialog', { name: 'Join a phone' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('img', { name: /QR code/ })).toBeVisible()
      const status = dialog.getByTestId('join-status')
      await expect(status).toContainText('Waiting')
      const url = (await dialog.getByTestId('join-url').innerText()).trim()
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/join\?t=/)
      expect(url).toBe((await plexo.api.getJoinState()).session?.urls[0].url)

      const phone = await openPhoneWindow(plexo)
      await phone.goto(url)
      await expect(phone).toHaveTitle('Join Plexo')
      const latency = phone.getByTestId('phase-latency')
      const download = phone.getByTestId('phase-download')
      const upload = phone.getByTestId('phase-upload')

      await expect(phone.getByTestId('result')).toBeVisible({ timeout: 30_000 })
      await expect(phone.getByTestId('result')).toContainText(/You['’]re in/)
      await expect(phone.getByRole('button', { name: 'Test again' })).toBeVisible()
      for (const phase of [latency, download, upload]) {
        await expect(phase).toHaveAttribute('data-state', /^(done|skipped)$/)
      }
      // The link to this computer is always measured; only the internet can be skipped.
      await expect(latency).toHaveAttribute('data-state', 'done')

      await expect.poll(() => plexo.api.getJoinState().then((s) => s.session?.status)).toBe('done')
      const state = await plexo.api.getJoinState()
      const joined = device(state)
      expect(joined).toMatchObject({ address: '127.0.0.1', viaInterfaceId: 'a' })
      expect(joined.capability.linkDownloadBps).toBeGreaterThan(0)
      expect(joined.capability.linkUploadBps).toBeGreaterThan(0)
      expect(joined.capability.linkLatencyMs).toBeGreaterThanOrEqual(0)
      expect(joined.capability.durationMs).toBeGreaterThan(0)
      await expect(status).not.toContainText(/Waiting|Measuring/)
      await expect(status).toContainText(joined.name)
      // Over loopback the whole measurement is done in well under a second — too quick to catch
      // the window saying "Measuring" — but it was told, in order: waiting, testing, done.
      const statuses = states.map((s) => s.session?.status)
      expect(statuses.indexOf('waiting')).toBeGreaterThanOrEqual(0)
      expect(statuses.indexOf('testing')).toBeGreaterThan(statuses.indexOf('waiting'))
      expect(statuses.lastIndexOf('done')).toBeGreaterThan(statuses.indexOf('testing'))
      await expect(dialog.getByRole('button', { name: 'Join another phone' })).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      await expect(page.getByRole('heading', { name: 'Joined Phones' })).toBeVisible()
      const card = page.getByTestId('joined-device')
      await expect(card).toHaveCount(1)
      await expect(card).toContainText(joined.name)
      await expect(card).toContainText(/down/i)
      await expect(card).toContainText(/up/i)
      await expect(card).toContainText(/ping/i)

      await card.getByRole('button', { name: `Remove ${joined.name}` }).click()
      await expect(card).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Joined Phones' })).toBeHidden()
      expect((await plexo.api.getJoinState()).devices).toEqual([])
    })

    test('the page says when it can’t reach Plexo, and Retry picks up once it can', async ({
      plexo
    }) => {
      const phone = await openSession(plexo)
      const page = await openPhoneWindow(plexo)
      // The page itself loads; every measurement call fails the way they do on the wrong Wi-Fi.
      await page.route('**/api/join/**', (route) => route.abort('connectionrefused'))
      await page.goto(phone.url('/join'))
      await expect(page).toHaveTitle('Join Plexo')

      const error = page.getByTestId('error')
      await expect(error).toBeVisible({ timeout: 30_000 })
      await expect(error).toContainText(/Can['’]t reach Plexo/)
      await expect(page.getByTestId('result')).toBeHidden()
      await expect(page.getByTestId('phase-latency')).not.toHaveAttribute('data-state', 'done')
      const state = await plexo.api.getJoinState()
      expect(state.session?.status).toBe('waiting')
      expect(state.devices).toEqual([])

      await page.unroute('**/api/join/**')
      await page.getByRole('button', { name: 'Retry' }).click()
      await expect(page.getByTestId('result')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('result')).toContainText(/You['’]re in/)
      await expect(error).toBeHidden()
      await expect.poll(() => plexo.api.getJoinState().then((s) => s.session?.status)).toBe('done')
      expect((await plexo.api.getJoinState()).devices).toHaveLength(1)
    })
  })
})
