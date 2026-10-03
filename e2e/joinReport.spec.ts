import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  buildJoinUrls,
  describeDevice,
  findInterfaceByAddress,
  normalizeAddress,
  parseSpeedTestReport,
  toJoinedDevice
} from '../src/main/join/report'
import type { NetworkInterfaceInfo } from '../src/shared/types'

// L. The pure half of joining a phone: what the phone's report has to look like to count, how a
// phone is named and placed on a network, and what the QR code links to. No app, no server.

type Report = NonNullable<ReturnType<typeof parseSpeedTestReport>>

const NUMERIC_FIELDS = [
  'internetLatencyMs',
  'internetDownloadBps',
  'internetUploadBps',
  'linkLatencyMs',
  'linkDownloadBps',
  'linkUploadBps',
  'durationMs'
] as const
const NULLABLE_FIELDS = ['internetLatencyMs', 'internetDownloadBps', 'internetUploadBps'] as const
const REQUIRED_FIELDS = NUMERIC_FIELDS.filter(
  (field) => !(NULLABLE_FIELDS as readonly string[]).includes(field)
)
const CONNECTION_TYPE_MAX = 32

/** `object` without `key` — a report with one field missing. */
const without = (object: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(object).filter(([k]) => k !== key))

const valid = {
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
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// --- arbitraries ------------------------------------------------------------------------------

/** A finite, non-negative number: what every figure in a report has to be. */
const figure = fc
  .oneof(
    fc.nat(),
    fc.double({ min: 0, max: 1e12, noNaN: true, noDefaultInfinity: true }).map(Math.abs)
  )
  .filter((n) => Number.isFinite(n) && n >= 0)
const nullableFigure = fc.option(figure, { nil: null })
const connectionType = fc.string({ minLength: 1, maxLength: CONNECTION_TYPE_MAX })

/** A report the phone could send. */
const validReport = fc.record(
  {
    internetLatencyMs: nullableFigure,
    internetDownloadBps: nullableFigure,
    internetUploadBps: nullableFigure,
    linkLatencyMs: figure,
    linkDownloadBps: figure,
    linkUploadBps: figure,
    durationMs: figure,
    connectionType
  },
  { requiredKeys: NUMERIC_FIELDS.slice() }
)

/** A value no numeric field may hold. */
const badFigure = fc.oneof(
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.double({ max: -Number.MIN_VALUE, noNaN: true }),
  fc.string(),
  fc.boolean(),
  fc.constant(undefined),
  fc.constant({}),
  fc.constant([])
)

/** A valid report with exactly one thing wrong with it. */
const invalidReport = fc.oneof(
  // A figure that isn't one.
  fc
    .tuple(validReport, fc.constantFrom(...NUMERIC_FIELDS), badFigure)
    .map(([report, field, value]) => ({ ...report, [field]: value })),
  // Null where only the internet figures may be.
  fc
    .tuple(validReport, fc.constantFrom(...REQUIRED_FIELDS))
    .map(([report, field]) => ({ ...report, [field]: null })),
  // A required figure missing altogether.
  fc
    .tuple(validReport, fc.constantFrom(...REQUIRED_FIELDS))
    .map(([report, field]) => without(report, field)),
  // A connection type that isn't a short string.
  fc
    .tuple(
      validReport,
      fc.oneof(
        fc.string({ minLength: CONNECTION_TYPE_MAX + 1, maxLength: CONNECTION_TYPE_MAX + 40 }),
        fc.nat(),
        fc.boolean(),
        fc.constant({})
      )
    )
    .map(([report, value]) => ({ ...report, connectionType: value })),
  // Not an object at all.
  fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.string(),
    fc.nat(),
    fc.boolean(),
    fc.array(fc.nat())
  )
)

/** A unicast IPv4 that isn't link-local, so no implementation has a reason to skip it. */
const ipv4 = fc
  .tuple(
    fc.integer({ min: 1, max: 223 }),
    fc.nat(255),
    fc.nat(255),
    fc.integer({ min: 1, max: 254 })
  )
  .map((octets) => octets.join('.'))
  .filter((address) => !address.startsWith('169.254.'))

const token = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'),
  minLength: 8,
  maxLength: 64
})

const iface = (
  overrides: Partial<NetworkInterfaceInfo> & Pick<NetworkInterfaceInfo, 'id'>
): NetworkInterfaceInfo => ({
  device: overrides.id,
  displayName: overrides.id,
  kind: 'ethernet',
  addresses: [],
  ...overrides
})

const interfaceArb = fc
  .record({
    id: fc.string({
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'),
      minLength: 1,
      maxLength: 8
    }),
    kind: fc.constantFrom('wifi', 'ethernet', 'usb', 'bridge', 'other') as fc.Arbitrary<
      NetworkInterfaceInfo['kind']
    >,
    addresses: fc.array(
      fc.oneof(
        ipv4.map((address) => ({ address, family: 4 as const })),
        fc.constant({ address: 'fe80::1', family: 6 as const })
      ),
      { maxLength: 3 }
    )
  })
  .map((fields) => iface({ ...fields, displayName: `Network ${fields.id}` }))

// --- parseSpeedTestReport ---------------------------------------------------------------------

test.describe('parseSpeedTestReport', () => {
  test('a well-formed report comes back with its figures, nothing more', () => {
    const parsed = parseSpeedTestReport({ ...valid, extra: 'ignored', nested: { a: 1 } })
    expect(parsed).toEqual(valid)
  })

  test('the internet figures may be null; the link figures may not', () => {
    const noInternet = {
      ...valid,
      internetLatencyMs: null,
      internetDownloadBps: null,
      internetUploadBps: null
    }
    expect(parseSpeedTestReport(noInternet)).toEqual(noInternet)
    for (const field of REQUIRED_FIELDS) {
      expect(parseSpeedTestReport({ ...valid, [field]: null }), `${field}: null`).toBeNull()
    }
  })

  test('NaN, infinite and negative figures are refused', () => {
    for (const field of NUMERIC_FIELDS) {
      expect(parseSpeedTestReport({ ...valid, [field]: Number.NaN }), `${field}: NaN`).toBeNull()
      expect(
        parseSpeedTestReport({ ...valid, [field]: Number.POSITIVE_INFINITY }),
        `${field}: Infinity`
      ).toBeNull()
      expect(parseSpeedTestReport({ ...valid, [field]: -1 }), `${field}: -1`).toBeNull()
      expect(parseSpeedTestReport({ ...valid, [field]: '12' }), `${field}: "12"`).toBeNull()
    }
  })

  test('zero is a figure', () => {
    const zeros = Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, 0]))
    expect(parseSpeedTestReport({ ...valid, ...zeros })).toEqual({ ...valid, ...zeros })
  })

  test('a required figure missing is refused', () => {
    for (const field of REQUIRED_FIELDS) {
      expect(parseSpeedTestReport(without(valid, field)), `without ${field}`).toBeNull()
    }
  })

  test('connectionType is optional, a string, and short', () => {
    const withoutType = without(valid, 'connectionType')
    expect(parseSpeedTestReport(withoutType)).toEqual(withoutType)
    expect(
      parseSpeedTestReport({ ...valid, connectionType: 'x'.repeat(CONNECTION_TYPE_MAX) })
    ).toEqual({
      ...valid,
      connectionType: 'x'.repeat(CONNECTION_TYPE_MAX)
    })
    expect(
      parseSpeedTestReport({ ...valid, connectionType: 'x'.repeat(CONNECTION_TYPE_MAX + 1) })
    ).toBeNull()
    expect(parseSpeedTestReport({ ...valid, connectionType: 4 })).toBeNull()
    // JSON can't carry undefined: a phone with no reading sends null, which is the same thing.
    expect(parseSpeedTestReport({ ...valid, connectionType: null })).toEqual(withoutType)
    expect(parseSpeedTestReport({ ...valid, connectionType: { effectiveType: '4g' } })).toBeNull()
  })

  test('anything that is not an object is refused', () => {
    for (const body of [null, undefined, 'report', 42, true, [], [valid]]) {
      expect(parseSpeedTestReport(body), JSON.stringify(body)).toBeNull()
    }
  })

  test('every report the phone could send is accepted, and parsing is idempotent', () => {
    fc.assert(
      fc.property(validReport, (report) => {
        const parsed = parseSpeedTestReport(report)
        expect(parsed).not.toBeNull()
        for (const field of NUMERIC_FIELDS) expect(parsed![field]).toBe(report[field])
        expect(parseSpeedTestReport(parsed)).toEqual(parsed)
      })
    )
  })

  test('whatever comes in, parsing twice is the same as parsing once', () => {
    fc.assert(
      fc.property(fc.oneof(validReport, invalidReport, fc.anything()), (body) => {
        const once = parseSpeedTestReport(body)
        expect(parseSpeedTestReport(once)).toEqual(once)
      })
    )
  })

  test('a report with one thing wrong is refused', () => {
    fc.assert(
      fc.property(invalidReport, (body) => {
        expect(parseSpeedTestReport(body)).toBeNull()
      })
    )
  })
})

// --- describeDevice ---------------------------------------------------------------------------

test.describe('describeDevice', () => {
  test('names the phone from its browser', () => {
    expect(describeDevice(IPHONE_UA)).toEqual({ name: 'iPhone', platform: 'ios' })
    expect(describeDevice(ANDROID_UA)).toEqual({ name: 'Android phone', platform: 'android' })
    expect(describeDevice(DESKTOP_UA)).toEqual({ name: 'Phone', platform: 'other' })
    expect(describeDevice(undefined)).toEqual({ name: 'Phone', platform: 'other' })
    expect(describeDevice('')).toEqual({ name: 'Phone', platform: 'other' })
  })

  test('any user agent gets a name that fits its platform', () => {
    const names: Record<string, string[]> = {
      ios: ['iPhone', 'iPad'],
      android: ['Android phone'],
      other: ['Phone']
    }
    fc.assert(
      fc.property(fc.option(fc.string({ unit: 'binary' }), { nil: undefined }), (ua) => {
        const device = describeDevice(ua)
        expect(Object.keys(names)).toContain(device.platform)
        expect(names[device.platform]).toContain(device.name)
      })
    )
  })
})

// --- normalizeAddress / findInterfaceByAddress ------------------------------------------------

test.describe('addresses', () => {
  test('an IPv4-mapped IPv6 address is the IPv4 it wraps; anything else is left alone', () => {
    expect(normalizeAddress('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeAddress('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeAddress('::1')).toBe('::1')
    expect(normalizeAddress('2001:db8::2')).toBe('2001:db8::2')
  })

  test('normalizing is idempotent for every IPv4, wrapped or not', () => {
    fc.assert(
      fc.property(ipv4, (address) => {
        expect(normalizeAddress(`::ffff:${address}`)).toBe(address)
        expect(normalizeAddress(address)).toBe(address)
      })
    )
  })

  test('the interface a connection came in on is the one with its local address', () => {
    const interfaces = [
      iface({ id: 'en0', kind: 'wifi', addresses: [{ address: '192.168.1.10', family: 4 }] }),
      iface({
        id: 'en5',
        addresses: [
          { address: 'fe80::1', family: 6 },
          { address: '10.0.0.2', family: 4 }
        ]
      }),
      iface({ id: 'lo0', addresses: [{ address: '127.0.0.1', family: 4 }] })
    ]
    expect(findInterfaceByAddress(interfaces, '10.0.0.2')).toBe('en5')
    expect(findInterfaceByAddress(interfaces, '192.168.1.10')).toBe('en0')
    // A dual-stack listener reports IPv4 peers in the mapped form.
    expect(findInterfaceByAddress(interfaces, '::ffff:127.0.0.1')).toBe('lo0')
    expect(findInterfaceByAddress(interfaces, '172.16.0.1')).toBeUndefined()
    expect(findInterfaceByAddress(interfaces, undefined)).toBeUndefined()
    expect(findInterfaceByAddress([], '127.0.0.1')).toBeUndefined()
  })

  test('whichever interface holds the address is found, wrapped or not', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(interfaceArb, { selector: (i) => i.id, minLength: 1, maxLength: 5 }),
        fc.nat(4),
        fc.boolean(),
        (interfaces, pick, wrapped) => {
          const withV4 = interfaces.filter((i) => i.addresses.some((a) => a.family === 4))
          fc.pre(withV4.length > 0)
          const target = withV4[pick % withV4.length]
          const address = target.addresses.find((a) => a.family === 4)!.address
          const holders = interfaces.filter((i) =>
            i.addresses.some((a) => a.family === 4 && a.address === address)
          )
          const found = findInterfaceByAddress(interfaces, wrapped ? `::ffff:${address}` : address)
          expect(holders.map((i) => i.id)).toContain(found)
        }
      )
    )
  })
})

// --- buildJoinUrls ----------------------------------------------------------------------------

test.describe('buildJoinUrls', () => {
  test('one link per network with an IPv4, Wi-Fi first', () => {
    const interfaces = [
      iface({
        id: 'en5',
        displayName: 'USB 10/100/1000 LAN',
        addresses: [{ address: '10.0.0.2', family: 4 }]
      }),
      iface({
        id: 'en6',
        displayName: 'IPv6 only',
        addresses: [{ address: 'fe80::1', family: 6 }]
      }),
      iface({
        id: 'en0',
        displayName: 'Wi-Fi',
        kind: 'wifi',
        addresses: [{ address: '192.168.1.10', family: 4 }]
      })
    ]
    expect(buildJoinUrls(interfaces, 4321, 'abc123')).toEqual([
      { interfaceId: 'en0', label: 'Wi-Fi', url: 'http://192.168.1.10:4321/join?t=abc123' },
      {
        interfaceId: 'en5',
        label: 'USB 10/100/1000 LAN',
        url: 'http://10.0.0.2:4321/join?t=abc123'
      }
    ])
  })

  test('an interface with no IPv4 gets no link', () => {
    expect(
      buildJoinUrls([iface({ id: 'en6', addresses: [{ address: 'fe80::1', family: 6 }] })], 1, 't')
    ).toEqual([])
    expect(buildJoinUrls([], 1, 't')).toEqual([])
  })

  test('every link carries the token, points at one of the interface’s IPv4s, and Wi-Fi comes first', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(interfaceArb, { selector: (i) => i.id, maxLength: 6 }),
        fc.integer({ min: 1, max: 65535 }),
        token,
        (interfaces, port, t) => {
          const urls = buildJoinUrls(interfaces, port, t)
          const withV4 = interfaces.filter((i) => i.addresses.some((a) => a.family === 4))
          expect(urls.map((u) => u.interfaceId).sort()).toEqual(withV4.map((i) => i.id).sort())
          let seenOther = false
          for (const link of urls) {
            const source = interfaces.find((i) => i.id === link.interfaceId)!
            const url = new URL(link.url)
            expect(url.protocol).toBe('http:')
            expect(url.pathname).toBe('/join')
            expect(url.searchParams.get('t')).toBe(t)
            expect(Number(url.port)).toBe(port)
            expect(source.addresses.map((a) => a.address)).toContain(url.hostname)
            expect(link.label).toBe(source.displayName)
            if (source.kind === 'wifi')
              expect(seenOther, 'a Wi-Fi link after a non-Wi-Fi one').toBe(false)
            else seenOther = true
          }
        }
      )
    )
  })
})

// --- toJoinedDevice ---------------------------------------------------------------------------

test.describe('toJoinedDevice', () => {
  test('a device carries what the phone reported, where it came from, and when', () => {
    const report: Report = parseSpeedTestReport(valid)!
    const now = 1_700_000_000_000
    const device = toJoinedDevice({
      id: 'dev-1',
      report,
      userAgent: IPHONE_UA,
      address: '192.168.1.23',
      viaInterfaceId: 'en0',
      now
    })
    expect(device).toEqual({
      id: 'dev-1',
      name: 'iPhone',
      platform: 'ios',
      connectionType: '4g',
      address: '192.168.1.23',
      viaInterfaceId: 'en0',
      joinedAt: now,
      capability: {
        internetLatencyMs: valid.internetLatencyMs,
        internetDownloadBps: valid.internetDownloadBps,
        internetUploadBps: valid.internetUploadBps,
        linkLatencyMs: valid.linkLatencyMs,
        linkDownloadBps: valid.linkDownloadBps,
        linkUploadBps: valid.linkUploadBps,
        measuredAt: now,
        durationMs: valid.durationMs
      }
    })
  })

  test('what isn’t known is left out, not made up', () => {
    const device = toJoinedDevice({
      id: 'dev-2',
      report: parseSpeedTestReport(without(valid, 'connectionType'))!,
      userAgent: undefined,
      address: '10.0.0.9',
      viaInterfaceId: undefined,
      now: 1
    })
    expect(device.name).toBe('Phone')
    expect(device.platform).toBe('other')
    expect(device.connectionType).toBeUndefined()
    expect(device.viaInterfaceId).toBeUndefined()
  })

  test('every figure in the report ends up in the device’s capability', () => {
    fc.assert(
      fc.property(
        validReport,
        fc.constantFrom(IPHONE_UA, ANDROID_UA, DESKTOP_UA, undefined),
        ipv4,
        fc.option(fc.constantFrom('a', 'b', 'en0'), { nil: undefined }),
        fc.nat(),
        (raw, userAgent, address, viaInterfaceId, now) => {
          const report = parseSpeedTestReport(raw)!
          const device = toJoinedDevice({
            id: 'x',
            report,
            userAgent,
            address,
            viaInterfaceId,
            now
          })
          for (const field of NUMERIC_FIELDS) expect(device.capability[field]).toBe(report[field])
          expect(device.capability.measuredAt).toBe(now)
          expect(device.joinedAt).toBe(now)
          expect(device.connectionType).toBe(report.connectionType)
          expect(device.address).toBe(address)
          expect(device.viaInterfaceId).toBe(viaInterfaceId)
          expect(device).toMatchObject(describeDevice(userAgent))
        }
      )
    )
  })
})
