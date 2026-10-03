import type { JoinedDevice, SpeedTestResult } from '@shared/types'
import { Smartphone, X } from 'lucide-react'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { formatBitrate, formatLatency } from '../utils/format'
import { ColorBadge } from './ColorBadge'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface JoinedDeviceCardProps {
  device: JoinedDevice
  onRemove: () => void
}

const LINK_ONLY_HINT = 'No internet reading — this is the link to this computer'

interface Figures {
  /** False when these are the phone-to-this-computer figures standing in for internet ones. */
  internet: boolean
  downBps: number
  upBps: number
  latencyMs: number
}

function pickFigures(capability: SpeedTestResult): Figures {
  const { internetDownloadBps, internetUploadBps, internetLatencyMs } = capability
  if (internetDownloadBps !== null && internetUploadBps !== null && internetLatencyMs !== null) {
    return {
      internet: true,
      downBps: internetDownloadBps,
      upBps: internetUploadBps,
      latencyMs: internetLatencyMs
    }
  }
  return {
    internet: false,
    downBps: capability.linkDownloadBps,
    upBps: capability.linkUploadBps,
    latencyMs: capability.linkLatencyMs
  }
}

function Readout({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[5px]">
      <div className="font-mono text-[9px] leading-none font-medium tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-[13px] leading-none font-medium text-foreground">{value}</div>
    </div>
  )
}

/** A phone that joined, laid out like a NetworkCard: what it is, where it came in from, and
 * what its connection measured. Internet figures are shown when the phone could reach the
 * probe; otherwise the link to this computer stands in, with a hint saying so. */
export function JoinedDeviceCard({ device, onRemove }: JoinedDeviceCardProps): React.JSX.Element {
  const interfaces = useAppStore((store) => store.interfaces)
  const resolveVisual = useNetworkVisuals()
  const via = interfaces.find((iface) => iface.id === device.viaInterfaceId)
  const viaLabel = via
    ? resolveVisual(via.id, via.kind, via.displayName).name
    : device.viaInterfaceId

  const figures = pickFigures(device.capability)
  const readouts = (
    <div className="flex items-end justify-between gap-3">
      <Readout label="DOWN" value={formatBitrate(figures.downBps)} />
      <Readout label="UP" value={formatBitrate(figures.upBps)} />
      <Readout label="PING" value={formatLatency(figures.latencyMs)} />
    </div>
  )

  return (
    <div
      data-testid="joined-device"
      className="flex flex-col gap-[11px] rounded-[11px] border-[0.5px] p-[15px]"
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-[9px]">
        <div className="flex min-w-0 flex-1 items-center gap-[9px]">
          <Smartphone className="size-[15px] shrink-0 text-[var(--color-usb)]" aria-hidden />
          <div className="min-w-0 truncate font-sans text-[13px] leading-normal font-semibold text-foreground">
            {device.name}
          </div>
        </div>
        <ColorBadge
          bg="var(--color-usb-bg)"
          border="var(--color-usb-border)"
          text="var(--color-usb-text)"
          className="font-mono text-[10px] tracking-[0.1em]"
        >
          {device.connectionType ? device.connectionType.toUpperCase() : 'PHONE'}
        </ColorBadge>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${device.name}`}
          onClick={onRemove}
          className="-mr-1.5 shrink-0 text-muted-foreground"
        >
          <X className="size-3" />
        </Button>
      </div>
      <div className="truncate font-mono text-[10.5px] leading-normal text-muted-foreground">
        {device.address}
        {viaLabel && ` · via ${viaLabel}`}
      </div>
      {figures.internet ? (
        readouts
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="group"
                tabIndex={0}
                aria-label={LINK_ONLY_HINT}
                className="rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            }
          >
            {readouts}
          </TooltipTrigger>
          <TooltipContent>{LINK_ONLY_HINT}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
