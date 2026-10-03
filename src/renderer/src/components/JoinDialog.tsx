import type { JoinedDevice, JoinSession, JoinUrl, SpeedTestPhase } from '@shared/types'
import { cn } from 'cn'
import { AlertTriangle, Check, QrCode as QrCodeIcon } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { formatBitrate, formatLatency } from '../utils/format'
import { ColorBadge } from './ColorBadge'
import { QrCode } from './QrCode'
import { Alert, AlertDescription } from './ui/alert'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/** In the order the phone measures them. */
const PHASES: Array<{ id: SpeedTestPhase; label: string }> = [
  { id: 'latency', label: 'Latency' },
  { id: 'download', label: 'Download' },
  { id: 'upload', label: 'Upload' }
]

const QR_TILE_CLASS = 'size-[168px] shrink-0'

const fieldLabelClass =
  'font-mono text-[9px] leading-none font-medium tracking-[0.12em] text-muted-foreground uppercase'

function ErrorLine({ message }: { message: string }): React.JSX.Element {
  return (
    <Alert variant="destructive" className="py-1.5">
      <AlertTriangle />
      <AlertDescription className="text-xs">{message}</AlertDescription>
    </Alert>
  )
}

function PulsingDot(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="size-[7px] shrink-0 rounded-full bg-[var(--color-accent)] animate-[plexo-glow_1.6s_ease-in-out_infinite] motion-reduce:animate-none"
    />
  )
}

function StatusLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">{children}</div>
  )
}

/** "↓ 12.4 Mbps · ↑ 3.1 Mbps · 24 ms", with a dash for any figure the phone couldn't get. */
function figures(down: number | null, up: number | null, latencyMs: number | null): string {
  const bitrate = (value: number | null): string => (value === null ? '—' : formatBitrate(value))
  const latency = latencyMs === null ? '—' : formatLatency(latencyMs)
  return `↓ ${bitrate(down)} · ↑ ${bitrate(up)} · ${latency}`
}

function PhaseList({ phase }: { phase: SpeedTestPhase }): React.JSX.Element {
  const current = PHASES.findIndex((step) => step.id === phase)
  return (
    <div className="flex flex-col gap-2.5">
      <ol className="flex flex-col gap-1.5">
        {PHASES.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'active' : 'pending'
          return (
            <li
              key={step.id}
              data-phase={step.id}
              data-state={state}
              className={cn(
                'flex items-center gap-2 font-mono text-[11px] tracking-[0.06em]',
                state === 'active' && 'font-medium text-foreground',
                state === 'done' && 'text-[var(--text-secondary)]',
                state === 'pending' && 'text-muted-foreground/70'
              )}
            >
              <span className="flex size-[14px] shrink-0 items-center justify-center">
                {state === 'done' && <Check className="size-3 text-[var(--color-success)]" />}
                {state === 'active' && <PulsingDot />}
                {state === 'pending' && (
                  <span className="size-[5px] rounded-full bg-[var(--icon-muted-strong)]" />
                )}
              </span>
              {step.label}
            </li>
          )
        })}
      </ol>
      <StatusLine>Measuring {phase}…</StatusLine>
    </div>
  )
}

function DeviceSummary({
  device,
  onAnother
}: {
  device: JoinedDevice | undefined
  onAnother: () => void
}): React.JSX.Element {
  const capability = device?.capability
  const hasInternet =
    capability !== undefined &&
    (capability.internetDownloadBps !== null ||
      capability.internetUploadBps !== null ||
      capability.internetLatencyMs !== null)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-success)] text-white">
          <Check className="size-2.5" strokeWidth={3} aria-label="Joined" />
        </span>
        <span className="min-w-0 truncate font-sans text-[13px] leading-normal font-semibold text-foreground">
          {device?.name ?? 'Phone'}
        </span>
        {device?.connectionType && (
          <ColorBadge
            bg="var(--color-usb-bg)"
            border="var(--color-usb-border)"
            text="var(--color-usb-text)"
            className="font-mono text-[10px] tracking-[0.1em]"
          >
            {device.connectionType.toUpperCase()}
          </ColorBadge>
        )}
      </div>
      {capability && (
        <div className="flex flex-col gap-1">
          <div className="font-mono text-[11px] leading-snug font-medium text-foreground">
            {hasInternet
              ? figures(
                  capability.internetDownloadBps,
                  capability.internetUploadBps,
                  capability.internetLatencyMs
                )
              : 'No internet reading'}
          </div>
          <div className="font-mono text-[10px] leading-snug text-muted-foreground">
            to this computer:{' '}
            {figures(
              capability.linkDownloadBps,
              capability.linkUploadBps,
              capability.linkLatencyMs
            )}
          </div>
        </div>
      )}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={onAnother}
      >
        Join another phone
      </Button>
    </div>
  )
}

function SessionStatus({
  session,
  device,
  onRestart
}: {
  session: JoinSession
  device: JoinedDevice | undefined
  onRestart: () => void
}): React.JSX.Element {
  switch (session.status) {
    case 'waiting':
      return (
        <StatusLine>
          <PulsingDot />
          Waiting for a phone…
        </StatusLine>
      )
    case 'testing':
      return <PhaseList phase={session.phase ?? 'latency'} />
    case 'done':
      return <DeviceSummary device={device} onAnother={onRestart} />
    case 'expired':
      return (
        <div className="flex flex-col gap-2">
          <StatusLine>This code expired.</StatusLine>
          <Button type="button" size="sm" className="self-start" onClick={onRestart}>
            New code
          </Button>
        </div>
      )
  }
}

function NetworkPicker({
  urls,
  selected,
  onSelect
}: {
  urls: JoinUrl[]
  selected: JoinUrl
  onSelect: (interfaceId: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div id="join-network-label" className={fieldLabelClass}>
        Network
      </div>
      <ToggleGroup
        value={[selected.interfaceId]}
        onValueChange={(values) => {
          if (values.length > 0) onSelect(String(values[0]))
        }}
        aria-labelledby="join-network-label"
        variant="pill"
        size="xs"
        spacing={1}
        className="flex-wrap"
      >
        {urls.map((url) => (
          // h-6: WCAG 2.5.8's 24px floor — the xs toggle size is 20px.
          <ToggleGroupItem
            key={url.interfaceId}
            value={url.interfaceId}
            className="h-6 max-w-[160px] truncate px-2"
          >
            {url.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/** Shows the QR code a phone scans to join, and follows the session from there: waiting,
 * measuring, reported. Closing it ends the session. */
export function JoinDialog(): React.JSX.Element {
  const open = useAppStore((store) => store.joinDialogOpen)
  const session = useAppStore((store) => store.joinState.session)
  const devices = useAppStore((store) => store.joinState.devices)
  const joinError = useAppStore((store) => store.joinError)
  const closeJoinDialog = useAppStore((store) => store.closeJoinDialog)
  const restartJoinSession = useAppStore((store) => store.restartJoinSession)

  // Which network's link is on screen. Remembered against the session it was picked for, so a
  // new code goes back to the first link (Wi-Fi — the server puts it first).
  const [choice, setChoice] = useState<{ sessionId: string; interfaceId: string } | null>(null)
  const urls = session?.urls ?? []
  const chosen =
    session && choice?.sessionId === session.id
      ? urls.find((url) => url.interfaceId === choice.interfaceId)
      : undefined
  const selectedUrl = chosen ?? urls[0]
  const device = session?.deviceId
    ? devices.find((entry) => entry.id === session.deviceId)
    : undefined
  // A used or expired code no longer works — dim it so nobody keeps trying to scan it.
  const codeIsLive = session?.status === 'waiting' || session?.status === 'testing'
  const status = joinError ? 'error' : (session?.status ?? 'starting')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void closeJoinDialog()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <div className="flex gap-4">
          <div className="flex w-[168px] shrink-0 flex-col gap-2.5">
            {session && urls.length > 1 && selectedUrl && (
              <NetworkPicker
                urls={urls}
                selected={selectedUrl}
                onSelect={(interfaceId) => setChoice({ sessionId: session.id, interfaceId })}
              />
            )}
            {selectedUrl ? (
              <QrCode
                value={selectedUrl.url}
                className={cn(QR_TILE_CLASS, 'transition-opacity', !codeIsLive && 'opacity-30')}
              />
            ) : (
              <div
                aria-hidden
                className={cn(
                  QR_TILE_CLASS,
                  'flex items-center justify-center rounded-[10px] border border-dashed border-border text-[var(--icon-muted-strong)]'
                )}
              >
                <QrCodeIcon className="size-8" strokeWidth={1.25} />
              </div>
            )}
            {selectedUrl && (
              <div
                data-testid="join-url"
                className="font-mono text-[10.5px] leading-snug break-all text-muted-foreground select-text"
              >
                {selectedUrl.url}
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <DialogTitle className="pr-6">Join a phone</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Scan with your phone&apos;s camera. It opens a page that measures the phone&apos;s
              connection and reports back — nothing to install.
            </DialogDescription>
            <div
              data-testid="join-status"
              data-status={status}
              className="mt-auto flex flex-col gap-2 border-t border-border pt-3"
            >
              {joinError ? (
                <ErrorLine message={joinError} />
              ) : session ? (
                <SessionStatus
                  session={session}
                  device={device}
                  onRestart={() => void restartJoinSession()}
                />
              ) : (
                <StatusLine>
                  <PulsingDot />
                  Starting…
                </StatusLine>
              )}
              {session?.error && <ErrorLine message={session.error} />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
