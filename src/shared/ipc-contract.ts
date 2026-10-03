import type {
  AppSettings,
  DownloadUpdate,
  JoinState,
  NetworkInterfaceInfo,
  ProbeResult,
  StartDownloadRequest,
  UpdateInfo
} from './types'

/** The request/response half of the IPC surface (every IpcChannels entry except the
 * main->renderer push events, downloadUpdated, networksChanged and joinStateChanged) — one
 * source of truth for both plexoApi (preload) and registerIpcHandlers (main), so a signature
 * drift between the two is a compile error instead of a runtime one. */
export interface IpcContract {
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  pingInterfaces: { args: []; result: Record<string, number | null> }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  updateSettings: { args: [patch: AppSettings]; result: void }
  probeUrl: { args: [url: string]; result: ProbeResult }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  readClipboardText: { args: []; result: string }
  revealInFolder: { args: [filePath: string]; result: void }
  startDownload: { args: [request: StartDownloadRequest]; result: string }
  getCurrentDownload: { args: []; result: DownloadUpdate | null }
  pauseDownload: { args: [id: string]; result: void }
  resumeDownload: { args: [id: string]; result: void }
  setDownloadNetwork: { args: [id: string, networkId: string, enabled: boolean]; result: void }
  cancelDownload: { args: [id: string]; result: void }
  removeDownload: { args: [id: string]; result: void }
  checkForUpdate: { args: []; result: UpdateInfo | null }
  /** Opens a join session: starts the join server if it isn't running, mints a fresh link, and
   * returns the state with that session. Replaces any session still open. */
  startJoinSession: { args: []; result: JoinState }
  /** Closes the open session (its link stops working). Joined devices are kept. */
  stopJoinSession: { args: []; result: void }
  getJoinState: { args: []; result: JoinState }
  removeJoinedDevice: { args: [deviceId: string]; result: void }
}
