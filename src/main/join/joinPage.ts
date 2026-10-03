// The page a phone opens after scanning the Join QR code. It runs a short speed test against
// this computer (the "link") and, when configured, the internet, then POSTs the result back.
// Everything the page needs is inlined: the server's CSP allows only nonce'd inline script and
// style, and no external resources.

/** One set of endpoints a speed test runs against. */
export interface SpeedTestTarget {
  /** GET; answers fast with no body. Measures latency. */
  pingUrl: string
  /** GET; `{bytes}` is replaced with how many bytes to fetch. Measures download. */
  downloadUrlTemplate: string
  /** POST with a body of the size to measure. Measures upload. */
  uploadUrl: string
}

export interface JoinPageOptions {
  /** The CSP nonce the page's inline script and style carry. */
  nonce: string
  /** This computer's name, shown as what the phone is joining. */
  hostName: string
  /** The join server's own endpoints: the link between the phone and this computer. */
  link: SpeedTestTarget
  /** The internet endpoints; null skips the internet measurement. */
  internet: SpeedTestTarget | null
  /** POST {"phase": ...} as each phase starts. */
  progressUrl: string
  /** POST the SpeedTestReport once done. */
  reportUrl: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** JSON that is safe to drop inside a <script>: nothing in it can close the tag or break a line. */
function toScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --surface: #f6f6f7; --text: #1d1d1f; --text-2: #6e6e73; --border: #e0e0e2;
  --accent: #d97706; --accent-soft: #fef3c7; --success: #1f8a70; --success-soft: #e6f6f2;
  --danger: #dc2626; --danger-soft: #fef2f2; --danger-border: #fecaca;
  --font: -apple-system, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1e20; --surface: #202325; --text: #eae7e2; --text-2: #a9adb2; --border: #2b2f33;
    --accent: #d8a44c; --accent-soft: #33291a; --success: #4ea89a; --success-soft: #22312e;
    --danger: #eda3a3; --danger-soft: #2c1c1c; --danger-border: #4a2a2a;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.4;
  min-height: 100dvh; -webkit-font-smoothing: antialiased;
  padding: calc(env(safe-area-inset-top) + 36px) 22px calc(env(safe-area-inset-bottom) + 36px);
}
.page { max-width: 440px; margin: 0 auto; display: grid; gap: 30px; }
.wordmark { font: 600 11px/1 var(--mono); letter-spacing: 0.34em; color: var(--accent); }
.headline {
  margin-top: 14px; font-size: clamp(1.8rem, 8.5vw, 2.4rem); line-height: 1.08;
  font-weight: 700; letter-spacing: -0.025em; text-wrap: balance; overflow-wrap: anywhere;
}
.lede { margin-top: 10px; color: var(--text-2); font-size: 15px; min-height: 1.4em; }
.phases { list-style: none; position: relative; }
.phases::before {
  content: ''; position: absolute; left: 9px; top: 26px; bottom: 26px; width: 2px;
  background: var(--border);
}
.phase {
  position: relative; display: grid; column-gap: 14px; align-items: center; padding: 15px 0;
  grid-template-columns: 20px 1fr auto; grid-template-areas: 'dot name value' 'dot sub sub';
}
.phase + .phase { border-top: 1px solid var(--border); }
.dot {
  grid-area: dot; align-self: start; margin-top: 1px; width: 20px; height: 20px;
  border-radius: 50%; border: 2px solid var(--border); background: var(--bg);
  display: grid; place-items: center; transition: border-color 300ms var(--ease), background 300ms;
}
.dot svg { width: 11px; height: 11px; opacity: 0; transform: scale(0.6); transition: all 300ms var(--ease); }
.phase[data-state='active'] .dot { border-color: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
.phase[data-state='done'] .dot { border-color: var(--success); background: var(--success); }
.phase[data-state='done'] .dot svg { opacity: 1; transform: scale(1); }
.phase[data-state='skipped'] .dot { border-style: dashed; }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  60% { box-shadow: 0 0 0 8px transparent; }
}
.phase-name { grid-area: name; font-size: 16px; font-weight: 600; color: var(--text-2); transition: color 200ms; }
.phase[data-state='active'] .phase-name, .phase[data-state='done'] .phase-name { color: var(--text); }
.phase[data-state='skipped'] .phase-name { text-decoration: line-through; }
.phase-value {
  grid-area: value; font: 600 16px/1.4 var(--mono); color: var(--text); font-variant-numeric: tabular-nums;
  opacity: 0; transform: translateY(4px); transition: opacity 400ms var(--ease), transform 400ms var(--ease);
}
.phase-value.is-set { opacity: 1; transform: none; }
.phase-sub { grid-area: sub; font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.phase-sub:empty { display: none; }
.card { border: 1px solid var(--border); border-radius: 18px; background: var(--surface); padding: 24px 22px; }
.eyebrow { display: flex; align-items: center; gap: 8px; font: 600 11px/1 var(--mono); letter-spacing: 0.2em; color: var(--success); }
.eyebrow::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--success); }
.card h2 { margin-top: 12px; font-size: clamp(2.2rem, 11vw, 3rem); line-height: 1; letter-spacing: -0.035em; font-weight: 800; }
.result-lede { margin-top: 10px; font-size: 15px; color: var(--text-2); }
.result-lede strong { color: var(--text); font-weight: 600; }
.badge {
  display: inline-block; vertical-align: 1px; margin-left: 6px; padding: 2px 8px; border-radius: 999px;
  font: 600 11px/1.5 var(--mono); letter-spacing: 0.08em; color: var(--accent); background: var(--accent-soft);
}
.badge[hidden] { display: none; }
.summary {
  margin-top: 22px; display: grid; grid-template-columns: repeat(3, 1fr);
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
}
.cell { padding: 14px 0 12px; }
.cell + .cell { border-left: 1px solid var(--border); padding-left: 12px; }
.cell dt { font-size: 12px; font-weight: 600; color: var(--text-2); letter-spacing: 0.02em; }
.cell .num { display: block; margin-top: 6px; font: 600 clamp(1.5rem, 7.5vw, 2rem)/1 var(--mono); letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.cell .unit { font: 500 12px/1 var(--mono); color: var(--text-2); }
.cell .net { margin-top: 8px; font: 500 12px/1.4 var(--mono); color: var(--text-2); font-variant-numeric: tabular-nums; }
.legend { margin-top: 10px; font-size: 12px; color: var(--text-2); }
.button {
  margin-top: 22px; width: 100%; appearance: none; border: 0; border-radius: 12px; padding: 15px 18px;
  font: 600 16px var(--font); color: #fff; background: var(--text); cursor: pointer;
  transition: transform 150ms var(--ease), opacity 150ms;
}
@media (prefers-color-scheme: dark) { .button { color: #1b1e20; } }
.button:active { transform: scale(0.98); }
.button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.button:disabled { opacity: 0.5; cursor: default; }
.muted { margin-top: 14px; text-align: center; font-size: 13px; color: var(--text-2); }
.error { border-color: var(--danger-border); background: var(--danger-soft); }
.error .eyebrow { color: var(--danger); }
.error .eyebrow::before { background: var(--danger); }
.error h2 { font-size: clamp(1.6rem, 8vw, 2rem); letter-spacing: -0.03em; }
.error p { margin-top: 10px; font-size: 15px; color: var(--text-2); }
.error .detail { font: 12px/1.5 var(--mono); overflow-wrap: anywhere; }
.error .detail:empty, .error .button[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`

const SCRIPT = `
;(() => {
  'use strict'
  const PING_COUNT = 5
  const MIB = 1024 * 1024
  const LINK_DOWNLOAD_BYTES = 32 * MIB
  const INTERNET_DOWNLOAD_BYTES = 25 * MIB
  const LINK_DOWNLOAD_CAP_MS = 4000
  const INTERNET_DOWNLOAD_CAP_MS = 5000
  const UPLOAD_FIRST_BYTES = 2 * MIB
  const UPLOAD_SECOND_BYTES = 8 * MIB
  const UPLOAD_FAST_MS = 1000
  const UPLOAD_CAP_MS = 8000
  const RANDOM_BLOCK_BYTES = 64 * 1024
  const PHASES = ['latency', 'download', 'upload']

  class HttpError extends Error {
    constructor(status, url) {
      super('HTTP ' + status + ' from ' + url)
      this.status = status
    }
  }
  /** kind: 'unreachable' (link endpoint failed), 'expired' (404 from Plexo), 'rejected' (bad report). */
  class JoinError extends Error {
    constructor(kind, message) {
      super(message)
      this.kind = kind
    }
  }
  const toJoinError = (err) => {
    if (err instanceof JoinError) return err
    if (err instanceof HttpError && err.status === 404) return new JoinError('expired', err.message)
    return new JoinError('unreachable', err && err.message ? err.message : String(err))
  }

  // ---- formatting -------------------------------------------------------------------------
  const mbps = (bps) => {
    if (bps === null) return '—'
    const value = (bps * 8) / 1e6
    return value < 10 ? value.toFixed(1) : String(Math.round(value))
  }
  const fmtMbps = (bps) => (bps === null ? '—' : mbps(bps) + ' Mbps')
  const fmtMs = (ms) => (ms === null ? '—' : Math.round(ms) + ' ms')
  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }

  // ---- DOM ------------------------------------------------------------------------------------
  const ERROR_COPY = {
    unreachable: {
      title: "Can't reach Plexo",
      hint: 'Make sure this phone is on the same Wi‑Fi as ' + CONFIG.hostName + ', or tethered to it, then retry.'
    },
    expired: { title: 'This link has expired', hint: 'Open Plexo and scan again.' },
    rejected: {
      title: "Plexo didn't accept the result",
      hint: 'Try again. If it keeps happening, restart Plexo and scan a fresh code.'
    }
  }
  const $ = (id) => document.getElementById(id)
  const ui = {
    status: (text) => { $('status').textContent = text },
    phaseState: (phase, state) => { $('phase-' + phase).dataset.state = state },
    phaseFigure: (phase, link, internet) => {
      const value = $(phase + '-link')
      value.textContent = link
      value.classList.add('is-set')
      $(phase + '-internet').textContent = internet === undefined ? '' : 'to the internet: ' + internet
    },
    reset: () => {
      for (const phase of PHASES) {
        ui.phaseState(phase, 'idle')
        $(phase + '-link').textContent = ''
        $(phase + '-link').classList.remove('is-set')
        $(phase + '-internet').textContent = ''
      }
      $('result').hidden = true
      $('error').hidden = true
      ui.status("Measuring this phone's connection — about ten seconds.")
    },
    done: (report, joined, elapsedMs) => {
      $('device-name').textContent = joined && joined.name ? joined.name : 'This phone'
      const badge = $('badge')
      badge.hidden = !report.connectionType
      badge.textContent = (report.connectionType || '').toUpperCase()
      $('sum-down').textContent = mbps(report.linkDownloadBps)
      $('sum-up').textContent = mbps(report.linkUploadBps)
      $('sum-ping').textContent = String(Math.round(report.linkLatencyMs))
      $('sum-down-net').textContent = fmtMbps(report.internetDownloadBps)
      $('sum-up-net').textContent = fmtMbps(report.internetUploadBps)
      $('sum-ping-net').textContent = fmtMs(report.internetLatencyMs)
      ui.status('Measured in ' + (elapsedMs / 1000).toFixed(1) + ' s.')
      $('result').hidden = false
    },
    fail: (error, activePhase) => {
      let reached = false
      for (const phase of PHASES) {
        if (phase === activePhase) reached = true
        if ($('phase-' + phase).dataset.state !== 'done') ui.phaseState(phase, reached && phase !== activePhase ? 'skipped' : 'idle')
      }
      const expired = error.kind === 'expired'
      const copy = ERROR_COPY[error.kind] || ERROR_COPY.unreachable
      $('error-title').textContent = copy.title
      $('error-hint').textContent = copy.hint
      $('error-detail').textContent = error.message || ''
      $('retry').hidden = expired
      ui.status(expired ? 'Nothing was recorded.' : 'The test stopped early.')
      $('error').hidden = false
    }
  }

  // ---- measurements ---------------------------------------------------------------------------
  const noStore = (init) => Object.assign({ cache: 'no-store' }, init)
  const checked = async (url, init) => {
    const res = await fetch(url, noStore(init))
    if (!res.ok) throw new HttpError(res.status, url)
    return res
  }

  const pingOnce = async (url) => {
    const t0 = performance.now()
    await checked(url)
    return performance.now() - t0
  }
  const measureLatency = async (target) => {
    const samples = []
    for (let i = 0; i < PING_COUNT; i += 1) samples.push(await pingOnce(target.pingUrl))
    return median(samples)
  }

  /** Streams the requested bytes, giving up after capMs; bytes/elapsed from whatever arrived. */
  const measureDownload = async (target, bytes, capMs) => {
    const url = target.downloadUrlTemplate.replace('{bytes}', String(bytes))
    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), capMs)
    let received = 0
    let startedAt = 0
    try {
      const res = await checked(url, { signal: controller.signal })
      if (!res.body) throw new Error('no body from ' + url)
      const reader = res.body.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!startedAt) {
          startedAt = performance.now()
          clearTimeout(timer)
          timer = setTimeout(() => controller.abort(), capMs)
        }
        received += chunk.value.byteLength
      }
    } catch (err) {
      if (!(controller.signal.aborted && received > 0)) throw err
    } finally {
      clearTimeout(timer)
    }
    if (received === 0) throw new Error('no data arrived from ' + url)
    const elapsedMs = Math.max(1, performance.now() - startedAt)
    return received / (elapsedMs / 1000)
  }

  const randomBody = (bytes) => {
    const body = new Uint8Array(bytes)
    for (let offset = 0; offset < bytes; offset += RANDOM_BLOCK_BYTES) {
      crypto.getRandomValues(body.subarray(offset, Math.min(offset + RANDOM_BLOCK_BYTES, bytes)))
    }
    return body
  }
  const uploadOnce = async (url, bytes, signal) => {
    const body = randomBody(bytes)
    const t0 = performance.now()
    await checked(url, { method: 'POST', body, signal })
    const elapsedMs = Math.max(1, performance.now() - t0)
    return { elapsedMs, bps: bytes / (elapsedMs / 1000) }
  }
  /** 2 MiB first; if that was quick, 8 MiB. fetch can't see upload progress, so bytes / total time. */
  const measureUpload = async (target) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPLOAD_CAP_MS)
    let best = null
    try {
      best = await uploadOnce(target.uploadUrl, UPLOAD_FIRST_BYTES, controller.signal)
      if (best.elapsedMs < UPLOAD_FAST_MS) best = await uploadOnce(target.uploadUrl, UPLOAD_SECOND_BYTES, controller.signal)
    } catch (err) {
      // Keep the completed smaller attempt unless Plexo itself says the link is gone.
      if (!best || (err instanceof HttpError && err.status === 404)) throw err
    } finally {
      clearTimeout(timer)
    }
    return best.bps
  }

  /** Internet figures are best-effort: any failure is reported as null, never as an error. */
  const internetOrNull = async (run) => {
    if (!CONFIG.internet) return null
    try {
      return await run(CONFIG.internet)
    } catch (err) {
      console.warn('internet measurement failed', err)
      return null
    }
  }

  // ---- the run ---------------------------------------------------------------------------------
  const postJson = (url, payload, init) =>
    fetch(url, noStore(Object.assign({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, init)))
  const announce = (phase) => {
    // Advisory only: Plexo uses it to animate its own window, so a lost message costs nothing.
    postJson(CONFIG.progressUrl, { phase }, { keepalive: true }).catch(() => undefined)
  }

  let running = false
  const run = async () => {
    if (running) return
    running = true
    ui.reset()
    const startedAt = performance.now()
    let phase = 'latency'
    try {
      announce(phase)
      ui.phaseState(phase, 'active')
      ui.status('Checking latency…')
      const linkLatencyMs = await measureLatency(CONFIG.link)
      const internetLatencyMs = await internetOrNull(measureLatency)
      const internetUp = internetLatencyMs !== null
      ui.phaseFigure(phase, fmtMs(linkLatencyMs), CONFIG.internet ? (internetUp ? fmtMs(internetLatencyMs) : 'unreachable') : undefined)
      ui.phaseState(phase, 'done')

      phase = 'download'
      announce(phase)
      ui.phaseState(phase, 'active')
      ui.status('Measuring download…')
      const linkDownloadBps = await measureDownload(CONFIG.link, LINK_DOWNLOAD_BYTES, LINK_DOWNLOAD_CAP_MS)
      const internetDownloadBps = internetUp
        ? await internetOrNull((target) => measureDownload(target, INTERNET_DOWNLOAD_BYTES, INTERNET_DOWNLOAD_CAP_MS))
        : null
      ui.phaseFigure(phase, fmtMbps(linkDownloadBps) + ' ↓', CONFIG.internet ? fmtMbps(internetDownloadBps) : undefined)
      ui.phaseState(phase, 'done')

      phase = 'upload'
      announce(phase)
      ui.phaseState(phase, 'active')
      ui.status('Measuring upload…')
      const linkUploadBps = await measureUpload(CONFIG.link)
      const internetUploadBps = internetUp ? await internetOrNull(measureUpload) : null
      ui.phaseFigure(phase, fmtMbps(linkUploadBps) + ' ↑', CONFIG.internet ? fmtMbps(internetUploadBps) : undefined)
      ui.phaseState(phase, 'done')

      phase = 'report'
      ui.status('Sending results…')
      const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10)
      const report = {
        internetLatencyMs: round1(internetLatencyMs),
        internetDownloadBps: internetDownloadBps === null ? null : Math.round(internetDownloadBps),
        internetUploadBps: internetUploadBps === null ? null : Math.round(internetUploadBps),
        linkLatencyMs: round1(linkLatencyMs),
        linkDownloadBps: Math.round(linkDownloadBps),
        linkUploadBps: Math.round(linkUploadBps),
        durationMs: Math.round(performance.now() - startedAt)
      }
      const connection = navigator.connection
      if (connection && typeof connection.effectiveType === 'string') report.connectionType = connection.effectiveType
      const res = await postJson(CONFIG.reportUrl, report)
      if (res.status === 404) throw new JoinError('expired', 'HTTP 404 from ' + CONFIG.reportUrl)
      if (!res.ok) throw new JoinError('rejected', 'HTTP ' + res.status + ' from ' + CONFIG.reportUrl)
      const joined = await res.json()
      ui.done(report, joined, report.durationMs)
    } catch (err) {
      const error = toJoinError(err)
      console.error('join failed during ' + phase, err)
      ui.fail(error, phase)
    } finally {
      running = false
    }
  }

  $('again').addEventListener('click', run)
  $('retry').addEventListener('click', run)
  run()
})()
`

const CHECK_ICON =
  '<svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.3 4.8 9 10 3.4"/></svg>'

function phaseItem(phase: 'latency' | 'download' | 'upload', label: string): string {
  return `<li class="phase" id="phase-${phase}" data-testid="phase-${phase}" data-state="idle">
  <span class="dot" aria-hidden="true">${CHECK_ICON}</span>
  <span class="phase-name">${label}</span>
  <span class="phase-value" id="${phase}-link"></span>
  <span class="phase-sub" id="${phase}-internet"></span>
</li>`
}

function summaryCell(key: string, label: string, unit: string): string {
  return `<div class="cell"><dt>${label}</dt><dd><span class="num" id="sum-${key}"></span><span class="unit">${unit}</span></dd><dd class="net" id="sum-${key}-net"></dd></div>`
}

export function renderJoinPage(options: JoinPageOptions): string {
  const nonce = escapeHtml(options.nonce)
  const host = escapeHtml(options.hostName)
  const config = toScriptJson({
    hostName: options.hostName,
    link: options.link,
    internet: options.internet,
    progressUrl: options.progressUrl,
    reportUrl: options.reportUrl
  })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1b1e20">
<title>Join Plexo</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main class="page">
  <header>
    <p class="wordmark">PLEXO</p>
    <h1 class="headline">Joining ${host}</h1>
    <p class="lede" id="status" aria-live="polite"></p>
  </header>
  <section aria-label="Speed test progress">
    <ol class="phases">
      ${phaseItem('latency', 'Latency')}
      ${phaseItem('download', 'Download')}
      ${phaseItem('upload', 'Upload')}
    </ol>
  </section>
  <section class="card result" id="result" data-testid="result" hidden>
    <p class="eyebrow">CONNECTED</p>
    <h2>You're in</h2>
    <p class="result-lede"><strong id="device-name"></strong> is now one of Plexo's connections.<span class="badge" id="badge" hidden></span></p>
    <dl class="summary">
      ${summaryCell('down', '↓ Down', 'Mbps')}
      ${summaryCell('up', '↑ Up', 'Mbps')}
      ${summaryCell('ping', 'Ping', 'ms')}
    </dl>
    <p class="legend">Large: this phone to ${host}. Small: to the internet.</p>
    <button type="button" class="button" id="again">Test again</button>
    <p class="muted">You can close this page.</p>
  </section>
  <section class="card error" id="error" data-testid="error" hidden>
    <p class="eyebrow">STOPPED</p>
    <h2 id="error-title"></h2>
    <p id="error-hint"></p>
    <p class="detail" id="error-detail"></p>
    <button type="button" class="button" id="retry">Retry</button>
  </section>
</main>
<script nonce="${nonce}">const CONFIG = ${config}
${SCRIPT}</script>
</body>
</html>
`
}
