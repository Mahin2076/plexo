import { applyDownloadUpdate } from '@shared/downloadUpdate'
import type {
  AppSettings,
  DownloadState,
  DownloadUpdate,
  JoinState,
  NetworkInterfaceInfo,
  NetworkPreference,
  NetworkPreferences,
  ThemeSource,
  UpdateInfo
} from '@shared/types'
import { create } from 'zustand'
import { describeError } from '../utils/format'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

const SPEED_HISTORY_LENGTH = 60
const SPEED_SAMPLE_INTERVAL_MS = 1000

// Throttling cadence lives outside the store's own state — it's bookkeeping for how often to
// sample, not something a component should ever read or re-render on.
let lastSpeedSampleAt = 0

interface AppStore {
  interfaces: NetworkInterfaceInfo[]
  interfacesStatus: LoadStatus
  interfacesError: string | null
  latencies: Record<string, number | null>
  /** User customizations (name/color) per network interface id — persisted in the main process. */
  networkPreferences: NetworkPreferences

  /** Persisted in the main process alongside nativeTheme.themeSource. */
  themeSource: ThemeSource

  /** Null until the one-time startup check resolves, or if it found nothing worth showing
   * (already up to date, already dismissed, or the check failed). */
  availableUpdate: UpdateInfo | null

  homeDir: string
  downloadsDir: string

  /** Plexo focuses on one download at a time — this is it. */
  currentDownload: DownloadState | null
  speedHistory: number[]
  /** Same rolling window as speedHistory, split by physical network — for the stacked
   * per-network throughput chart, keyed by interface id. */
  speedHistoryByInterface: Record<string, number[]>
  /** Highest combined speed seen so far this download — a rolling history window would lose it
   * once it ages out, so this is tracked as a running max instead. */
  peakSpeedBytesPerSec: number

  /** Lifted out of the Idle screen so it survives a swap to/from the No-connections screen. */
  draftUrl: string
  /** Persisted — the last folder picked, falling back to downloadsDir. */
  destinationDir: string

  /** The QR-code session and every phone that has joined — mirrored from the main process,
   * which pushes the whole thing on every change. */
  joinState: JoinState
  joinDialogOpen: boolean
  /** Why the last attempt to open a session failed (e.g. no network a phone could reach this
   * computer on) — shown in the dialog in place of the QR code. */
  joinError: string | null

  /** Asks the main process for the network list now; it also pushes every change. */
  loadInterfaces: () => Promise<void>
  receiveInterfaces: (interfaces: NetworkInterfaceInfo[]) => void
  refreshLatencies: () => Promise<void>
  setNetworkPreference: (id: string, patch: NetworkPreference) => void
  setThemeSource: (source: ThemeSource) => void
  checkForUpdate: () => Promise<void>
  dismissUpdate: () => void
  /** A snapshot or an update of the current download, from the main process. */
  receiveDownloadUpdate: (update: DownloadUpdate) => void
  clearCurrentDownload: () => void
  setDraftUrl: (url: string) => void
  setDestinationDir: (dir: string) => void

  receiveJoinState: (state: JoinState) => void
  /** Shows the dialog and asks the main process for a fresh session (a new QR code). */
  openJoinDialog: () => Promise<void>
  /** Hides the dialog and ends the session, so the code on screen stops working. */
  closeJoinDialog: () => Promise<void>
  /** A new code once the last one was used or expired, with the dialog staying open. */
  restartJoinSession: () => Promise<void>
  removeJoinedDevice: (deviceId: string) => void
}

// Settings saved by the main process, read once before the first paint (see InitialState).
const initial = window.plexo.initialState

/** Every setting changes optimistically: the store is updated first so the UI feels instant,
 * then this saves it. The store stays the source of truth either way — a failed save just means
 * the change isn't remembered next launch. */
function persist(patch: AppSettings): void {
  window.plexo.updateSettings(patch).catch(() => {})
}

export const useAppStore = create<AppStore>((set, get) => ({
  interfaces: [],
  interfacesStatus: 'idle',
  interfacesError: null,
  latencies: {},
  networkPreferences: initial.networkPreferences,
  themeSource: initial.themeSource,
  availableUpdate: null,

  homeDir: initial.homeDir,
  downloadsDir: initial.downloadsDir,

  currentDownload: null,
  speedHistory: [],
  speedHistoryByInterface: {},
  peakSpeedBytesPerSec: 0,

  draftUrl: '',
  destinationDir: initial.destinationDir ?? initial.downloadsDir,

  joinState: { session: null, devices: [] },
  joinDialogOpen: false,
  joinError: null,

  loadInterfaces: async () => {
    // A re-scan keeps showing the last result rather than flashing back to 'loading'.
    if (get().interfacesStatus !== 'ready') set({ interfacesStatus: 'loading' })
    set({ interfacesError: null })
    try {
      get().receiveInterfaces(await window.plexo.listInterfaces())
    } catch (error) {
      set({
        interfacesStatus: 'error',
        interfacesError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  receiveInterfaces: (interfaces) =>
    set({ interfaces, interfacesStatus: 'ready', interfacesError: null }),

  refreshLatencies: async () => {
    try {
      const latencies = await window.plexo.pingInterfaces()
      set({ latencies })
    } catch {
      // Latency is a nice-to-have readout — a failed probe just leaves stale values.
    }
  },

  // An explicit `undefined` in `patch` clears that field; main drops an entry left with neither.
  setNetworkPreference: (id, patch) => {
    const networkPreferences = {
      ...get().networkPreferences,
      [id]: { ...get().networkPreferences[id], ...patch }
    }
    set({ networkPreferences })
    persist({ networkPreferences })
  },

  setThemeSource: (themeSource) => {
    set({ themeSource })
    persist({ themeSource })
  },

  checkForUpdate: async () => {
    try {
      const availableUpdate = await window.plexo.checkForUpdate()
      set({ availableUpdate })
    } catch {
      // Best-effort — a failed check just leaves the banner hidden.
    }
  },

  dismissUpdate: () => {
    const update = get().availableUpdate
    if (!update) return
    // Keeps the update visible as a quiet titlebar icon rather than clearing it outright.
    set({ availableUpdate: { ...update, dismissed: true } })
    persist({ dismissedUpdateVersion: update.version })
  },

  receiveDownloadUpdate: (update) => {
    const previous = get().currentDownload
    const download = applyDownloadUpdate(previous, update)
    if (!download || download === previous) return
    const isNewDownload = !previous || previous.id !== download.id

    let speedHistory = isNewDownload ? [] : get().speedHistory
    let speedHistoryByInterface = isNewDownload ? {} : get().speedHistoryByInterface
    let peakSpeedBytesPerSec = isNewDownload ? 0 : get().peakSpeedBytesPerSec
    if (isNewDownload) lastSpeedSampleAt = 0

    if (download.status === 'downloading') {
      peakSpeedBytesPerSec = Math.max(peakSpeedBytesPerSec, download.speedBytesPerSec)

      const now = Date.now()
      if (now - lastSpeedSampleAt >= SPEED_SAMPLE_INTERVAL_MS) {
        lastSpeedSampleAt = now
        speedHistory = [...speedHistory, download.speedBytesPerSec].slice(-SPEED_HISTORY_LENGTH)

        const nextByInterface: Record<string, number[]> = {}
        for (const network of download.networks) {
          const previousSeries = speedHistoryByInterface[network.id] ?? []
          nextByInterface[network.id] = [...previousSeries, network.speedBytesPerSec].slice(
            -SPEED_HISTORY_LENGTH
          )
        }
        speedHistoryByInterface = nextByInterface
      }
    }

    set({ currentDownload: download, speedHistory, speedHistoryByInterface, peakSpeedBytesPerSec })
  },

  clearCurrentDownload: () =>
    set({
      currentDownload: null,
      speedHistory: [],
      speedHistoryByInterface: {},
      peakSpeedBytesPerSec: 0
    }),

  setDraftUrl: (draftUrl) => set({ draftUrl }),
  setDestinationDir: (destinationDir) => {
    set({ destinationDir })
    persist({ destinationDir })
  },

  receiveJoinState: (joinState) => set({ joinState }),

  openJoinDialog: async () => {
    set({ joinDialogOpen: true })
    await get().restartJoinSession()
  },

  closeJoinDialog: async () => {
    set({ joinDialogOpen: false, joinError: null })
    try {
      await window.plexo.stopJoinSession()
    } catch {
      // Best-effort: the session expires on its own, and the main process pushes that too.
    }
  },

  restartJoinSession: async () => {
    // The old code is gone either way; dropping it now means the dialog shows "starting" rather
    // than a stale done/expired session until the new one lands.
    set({ joinError: null, joinState: { ...get().joinState, session: null } })
    try {
      const joinState = await window.plexo.startJoinSession()
      if (!get().joinDialogOpen) {
        // Closed while the session was being opened — the stop that close sent may have run
        // before this session existed, so stop again rather than leave a live code behind.
        window.plexo.stopJoinSession().catch(() => {})
        return
      }
      set({ joinState })
    } catch (error) {
      set({ joinError: describeError(error) })
    }
  },

  removeJoinedDevice: (deviceId) => {
    const { joinState } = get()
    // Optimistic: the card goes right away, and the main process confirms with its next push.
    set({
      joinState: {
        ...joinState,
        devices: joinState.devices.filter((device) => device.id !== deviceId)
      }
    })
    window.plexo.removeJoinedDevice(deviceId).catch(() => {})
  }
}))
