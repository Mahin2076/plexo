import type { DownloadState } from '@shared/types'
import { useEffect, useState } from 'react'
import { TogetherPanel } from './components/TogetherPanel'
import { TitleBar, type TitleBarStatus } from './components/TitleBar'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { UpdateDialog } from './components/UpdateDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useNetworkEvents } from './hooks/useNetworks'
import { CompleteScreen } from './screens/CompleteScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { IdleScreen } from './screens/IdleScreen'
import { NoConnectionsScreen } from './screens/NoConnectionsScreen'
import { useAppStore } from './store/useAppStore'

function assertNever(status: never): never {
  throw new Error(`Unhandled download status: ${String(status)}`)
}

/** One screen + title-bar status per download.status — a switch with an assertNever default so
 * a new DownloadStatus value is a compile error here instead of silently falling into whichever
 * branch happened to be last. */
function renderDownload(
  download: DownloadState,
  handlers: { onNewDownload: () => void; onDownloadAgain: () => void }
): { screen: React.JSX.Element; titleBarStatus: TitleBarStatus } {
  switch (download.status) {
    case 'downloading':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'combined',
          networkCount: download.networks.filter((network) => network.status === 'on').length
        }
      }
    case 'paused':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'paused',
          networkCount: download.networks.filter((network) => network.enabled).length
        }
      }
    case 'completed':
      return {
        screen: <CompleteScreen download={download} onNewDownload={handlers.onNewDownload} />,
        titleBarStatus: { kind: 'none' }
      }
    case 'error':
    case 'cancelled':
      return {
        screen: (
          <ErrorScreen
            download={download}
            onNewDownload={handlers.onNewDownload}
            onDownloadAgain={handlers.onDownloadAgain}
          />
        ),
        titleBarStatus: { kind: 'none' }
      }
    default:
      return assertNever(download.status)
  }
}

function App(): React.JSX.Element {
  const [togetherMode, setTogetherMode] = useState(false)
  const [togetherRunning, setTogetherRunning] = useState(false)
  useDownloadEvents()
  useNetworkEvents()

  const interfaces = useAppStore((store) => store.interfaces)
  const interfacesStatus = useAppStore((store) => store.interfacesStatus)
  const currentDownload = useAppStore((store) => store.currentDownload)
  const clearCurrentDownload = useAppStore((store) => store.clearCurrentDownload)
  const checkForUpdate = useAppStore((store) => store.checkForUpdate)

  useEffect(() => {
    checkForUpdate()
  }, [checkForUpdate])

  const handleNewDownload = (): void => {
    if (currentDownload) void window.plexo.removeDownload(currentDownload.id)
    clearCurrentDownload()
  }

  const handleDownloadAgain = (): void => {
    if (currentDownload) {
      const url = currentDownload.url
      void window.plexo.removeDownload(currentDownload.id)
      clearCurrentDownload()
      useAppStore.getState().setDraftUrl(url)
    }
  }

  const noConnections = interfacesStatus === 'ready' && interfaces.length === 0

  let screen: React.JSX.Element
  let titleBarStatus: TitleBarStatus = { kind: 'none' }

  if (currentDownload) {
    ;({ screen, titleBarStatus } = renderDownload(currentDownload, {
      onNewDownload: handleNewDownload,
      onDownloadAgain: handleDownloadAgain
    }))
  } else if (noConnections) {
    screen = <NoConnectionsScreen />
    titleBarStatus = { kind: 'offline' }
  } else {
    screen = <IdleScreen />
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar status={titleBarStatus} />
        <nav
          className="flex gap-4 border-b border-border px-5 py-2 text-sm"
          aria-label="Download mode"
        >
          <button
            aria-pressed={!togetherMode}
            onClick={() => setTogetherMode(false)}
            className={!togetherMode ? 'font-semibold' : 'text-muted-foreground'}
          >
            Solo download
          </button>
          <button
            aria-pressed={togetherMode}
            onClick={() => setTogetherMode(true)}
            className={togetherMode ? 'font-semibold' : 'text-muted-foreground'}
          >
            Download Together{togetherRunning ? ' • Active' : ''}
          </button>
        </nav>
        <div className="min-h-0 flex-1" hidden={togetherMode}>
          {screen}
        </div>
        <div className="min-h-0 flex-1" hidden={!togetherMode}>
          <TogetherPanel active={togetherMode} onStatus={setTogetherRunning} />
        </div>
        <UpdateDialog />
        <NetworkBindingDialog />
      </div>
    </TooltipProvider>
  )
}

export default App
