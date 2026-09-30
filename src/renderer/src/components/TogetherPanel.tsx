import { useEffect, useState } from 'react'
import type { TogetherFile, TogetherState } from '@shared/together'
import { useAppStore } from '../store/useAppStore'
import { formatBytes } from '../utils/format'
import { Button } from './ui/button'

const inputClass = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const busyStatuses = ['waiting', 'downloading', 'verifying']

/** Kept mounted while hidden so mode changes cannot hide an ongoing session from its status tab. */
export function TogetherPanel({
  active,
  onStatus
}: {
  active: boolean
  onStatus: (running: boolean) => void
}): React.JSX.Element {
  const networks = useAppStore((store) => store.interfaces)
  const destination = useAppStore((store) => store.destinationDir)
  const setDestination = useAppStore((store) => store.setDestinationDir)
  const [mode, setMode] = useState<'host' | 'join'>('host')
  const [url, setUrl] = useState('')
  const [checksum, setChecksum] = useState('')
  const [network, setNetwork] = useState('')
  const [lan, setLan] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('Helper')
  const [budget, setBudget] = useState('500')
  const [preview, setPreview] = useState<TogetherFile | null>(null)
  const [session, setSession] = useState<TogetherState | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const selectedNetwork = network || networks[0]?.id || ''
  const addresses = networks.flatMap((iface) =>
    iface.addresses
      .filter((address) => address.family === 4)
      .map((address) => ({ address: address.address, name: iface.displayName }))
  )
  const selectedLan = lan || addresses[0]?.address || ''
  const running = !!session && busyStatuses.includes(session.status)

  useEffect(() => {
    onStatus(running)
  }, [running, onStatus])
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const next = await window.plexo.getTogether()
        if (!disposed) setSession(next)
      } catch (cause) {
        if (!disposed) setError(String(cause))
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500)
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [])

  const perform = async (action: () => Promise<unknown>): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await action()
      setSession(await window.plexo.getTogether())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  if (!active) return <></>

  return (
    <section hidden={!active} className="h-full overflow-y-auto p-5" aria-label="Download Together">
      <div className="mx-auto flex max-w-xl flex-col gap-4">
        <div>
          <h1 className="text-lg font-semibold">
            Download Together{' '}
            <span className="text-xs font-normal text-muted-foreground">Preview</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Friends fetch pieces through their own internet connections and send them to the host
            over your local network.
          </p>
        </div>
        <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
          Use a trusted local network and trusted helpers: pairing and transfers are not encrypted.
          Everyone with the join code can see the file link. Separate internet connections are
          needed for a speed boost. Together sessions do not resume after quitting.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}
        {session && (
          <div
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
            aria-label="Session progress"
          >
            <div className="flex justify-between gap-3">
              <strong className="break-all">{session.file.fileName}</strong>
              <span className="text-sm capitalize" data-testid="together-status">
                {session.status}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {session.role === 'host' ? 'Hosting' : 'Helping'} ·{' '}
              {formatBytes(session.file.totalBytes)}
            </p>
            {session.role === 'host' && session.code && running && (
              <label className="text-sm">
                Share this join code
                <input
                  aria-label="Host join code"
                  className={`${inputClass} mt-1 font-mono text-xs`}
                  value={session.code}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
                <span className="text-xs text-muted-foreground">
                  Your friend opens Download Together → Join, then pastes this code.
                </span>
              </label>
            )}
            <progress
              className="h-2 w-full"
              max={session.file.totalBytes}
              value={session.bytes}
              aria-label="File progress"
            />
            <p className="text-sm">
              {formatBytes(session.bytes)} / {formatBytes(session.file.totalBytes)} · This computer
              contributed {formatBytes(session.contributedBytes)}
            </p>
            {session.role === 'helper' && (
              <p className="text-xs text-muted-foreground">
                Source data used: {formatBytes(session.usedBytes)} /{' '}
                {formatBytes(session.budgetBytes ?? 0)}. Counts file payload; protocol overhead is
                extra.
              </p>
            )}
            {session.peers.map((peer, index) => (
              <p className="flex justify-between text-sm" key={index}>
                <span>
                  {peer.name} · {peer.status}
                </span>
                <span>{formatBytes(peer.bytes)}</span>
              </p>
            ))}
            {session.error && (
              <p role="alert" className="text-sm text-red-500">
                {session.error}
              </p>
            )}
            {session.status === 'stopped' && (
              <p className="text-sm text-muted-foreground">
                Session stopped. Helpers also stop when their remaining budget cannot fit another
                piece.
              </p>
            )}
            {session.sha256 && (
              <div className="text-xs">
                <p>
                  {session.file.expectedSha256
                    ? 'SHA-256 verified against your supplied checksum.'
                    : 'Transfer complete. No publisher checksum supplied; only transfer integrity was checked.'}
                </p>
                <p className="mt-1 break-all font-mono">SHA-256: {session.sha256}</p>
              </div>
            )}
            <div className="flex gap-2">
              {session.role === 'host' && session.status === 'waiting' && (
                <Button
                  disabled={pending}
                  onClick={() => void perform(() => window.plexo.startTogether())}
                >
                  Start together
                </Button>
              )}
              {running && (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => void perform(() => window.plexo.stopTogether())}
                >
                  {session.role === 'host' ? 'Stop session' : 'Stop helping'}
                </Button>
              )}
              {session.status === 'completed' && session.destinationPath && (
                <Button
                  onClick={() =>
                    void perform(() => window.plexo.revealInFolder(session.destinationPath!))
                  }
                >
                  Show file
                </Button>
              )}
            </div>
          </div>
        )}
        {!running && (
          <>
            <div className="flex gap-2" aria-label="Together mode">
              <Button
                variant={mode === 'host' ? 'default' : 'secondary'}
                onClick={() => {
                  setMode('host')
                  setError('')
                }}
              >
                Host
              </Button>
              <Button
                variant={mode === 'join' ? 'default' : 'secondary'}
                onClick={() => {
                  setMode('join')
                  setError('')
                }}
              >
                Join
              </Button>
            </div>
            <label className="text-sm">
              Internet connection
              <select
                aria-label="Internet connection"
                className={`${inputClass} mt-1`}
                value={selectedNetwork}
                onChange={(event) => setNetwork(event.target.value)}
              >
                {networks.map((iface) => (
                  <option key={iface.id} value={iface.id}>
                    {iface.displayName}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">
                Choose the connection that should fetch file pieces (for example, your USB hotspot).
              </span>
            </label>
            {mode === 'host' ? (
              <>
                <label className="text-sm">
                  Public download link
                  <input
                    className={`${inputClass} mt-1`}
                    type="url"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://example.com/file.zip"
                  />
                </label>
                <label className="text-sm">
                  Local address for friends to join
                  <select
                    className={`${inputClass} mt-1`}
                    value={selectedLan}
                    onChange={(event) => setLan(event.target.value)}
                  >
                    {addresses.map(({ address, name }) => (
                      <option key={address} value={address}>
                        {name} · {address}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="break-all">Save to: {destination}</span>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void perform(async () => {
                        const folder = await window.plexo.chooseDestinationFolder(destination)
                        if (folder) setDestination(folder)
                      })
                    }
                  >
                    Browse…
                  </Button>
                </div>
                <label className="text-sm">
                  Publisher SHA-256 (optional)
                  <input
                    className={`${inputClass} mt-1 font-mono text-xs`}
                    value={checksum}
                    onChange={(event) => setChecksum(event.target.value)}
                    placeholder="64-character checksum from the file publisher"
                  />
                </label>
                <Button
                  disabled={
                    pending || !url.trim() || !selectedNetwork || !selectedLan || !destination
                  }
                  onClick={() =>
                    void perform(() =>
                      window.plexo.hostTogether({
                        url: url.trim(),
                        destinationDir: destination,
                        internetInterfaceId: selectedNetwork,
                        lanAddress: selectedLan,
                        expectedSha256: checksum.trim() || undefined
                      })
                    )
                  }
                >
                  {pending ? 'Creating…' : 'Create session'}
                </Button>
              </>
            ) : (
              <>
                <label className="text-sm">
                  Join code
                  <input
                    className={`${inputClass} mt-1 font-mono text-xs`}
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value)
                      setPreview(null)
                    }}
                    placeholder="plexo://192.168.…"
                  />
                </label>
                <Button
                  variant="secondary"
                  disabled={pending || !code.trim()}
                  onClick={() =>
                    void perform(async () => {
                      setPreview(await window.plexo.previewTogether(code.trim()))
                    })
                  }
                >
                  Review file
                </Button>
                {preview && (
                  <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
                    <strong className="break-all">
                      {preview.fileName} · {formatBytes(preview.totalBytes)}
                    </strong>
                    <p className="break-all text-xs text-muted-foreground">Source: {preview.url}</p>
                    <p className="text-xs text-muted-foreground">
                      Joining lets this host use your selected connection to fetch this file. Pieces
                      are sent to the host; the complete file is saved on their computer.
                    </p>
                    <label className="text-sm">
                      Your name
                      <input
                        className={`${inputClass} mt-1`}
                        maxLength={48}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                    <label className="text-sm">
                      Maximum source data (MiB)
                      <input
                        className={`${inputClass} mt-1`}
                        type="number"
                        min="1"
                        step="1"
                        value={budget}
                        onChange={(event) => setBudget(event.target.value)}
                      />
                    </label>
                    <Button
                      disabled={
                        pending ||
                        !name.trim() ||
                        !selectedNetwork ||
                        !Number.isSafeInteger(Number(budget)) ||
                        Number(budget) < 1
                      }
                      onClick={() =>
                        void perform(() =>
                          window.plexo.joinTogether({
                            code: code.trim(),
                            file: preview,
                            name: name.trim(),
                            internetInterfaceId: selectedNetwork,
                            budgetBytes: Number(budget) * 1024 * 1024
                          })
                        )
                      }
                    >
                      Join and help
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}
