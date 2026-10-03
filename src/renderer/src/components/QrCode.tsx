import { cn } from 'cn'
import QRCode from 'qrcode'
import { useMemo } from 'react'

/** Modules of blank margin around the symbol — the spec asks for 4, but 2 scans reliably on
 * phones and keeps the tile compact. */
const QUIET_ZONE = 2

interface QrCodeProps {
  value: string
  className?: string
}

/** One SVG path covering every dark module: a single DOM node however big the code, built as a
 * string rather than markup so nothing is handed to innerHTML. */
function buildPath(data: Uint8Array, size: number): string {
  const parts: string[] = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (data[row * size + col]) {
        parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`)
      }
    }
  }
  return parts.join('')
}

/** A QR code for `value`, always dark-on-white: scanners expect that contrast, and the tile
 * stays white in dark mode on purpose. The SVG fills whatever box it's given. */
export function QrCode({ value, className }: QrCodeProps): React.JSX.Element {
  const { path, viewBox } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' })
    const extent = modules.size + QUIET_ZONE * 2
    return { path: buildPath(modules.data, modules.size), viewBox: `0 0 ${extent} ${extent}` }
  }, [value])

  return (
    <div className={cn('rounded-[10px] bg-white p-3 text-[#1d1d1f]', className)}>
      <svg
        role="img"
        aria-label="QR code: scan with your phone to join"
        viewBox={viewBox}
        shapeRendering="crispEdges"
        className="block size-full"
      >
        <path d={path} fill="currentColor" />
      </svg>
    </div>
  )
}
