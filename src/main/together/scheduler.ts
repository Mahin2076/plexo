import type { TogetherScheduler } from '../../shared/together'

export interface DeviceMetrics {
  id: string
  bytesPerSecond: number
  failures: number
  remainingBytes: number
}

/** Gemma supplies priorities, never credentials, offsets, leases or permission to write. */
export class ChunkScheduler {
  readonly status: TogetherScheduler = { mode: 'fallback', detail: 'Measuring device speeds' }
  private priority: string[] = []
  private validUntil = 0
  private nextRefresh = 0
  private pending = false
  private roster = ''
  private generation = 0

  constructor(
    private readonly endpoint = process.env.PLEXO_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    private readonly model = process.env.PLEXO_GEMMA_MODEL ?? 'gemma4:e2b',
    private readonly request: typeof fetch = fetch
  ) {}

  rank(devices: DeviceMetrics[], signal: AbortSignal): string[] {
    const roster = devices
      .map((device) => device.id)
      .sort()
      .join(',')
    if (this.roster !== roster) {
      this.roster = roster
      this.generation++
      this.priority = []
      this.validUntil = 0
      this.nextRefresh = 0
      this.status.mode = 'fallback'
      this.status.detail = 'Devices changed; refreshing Gemma priorities'
    }
    if (!signal.aborted && devices.length > 1 && !this.pending && Date.now() >= this.nextRefresh) {
      void this.refresh(devices, signal, this.generation)
    }
    if (this.validUntil > Date.now()) return [...this.priority]
    if (this.status.mode === 'gemma')
      this.status.detail = 'Refreshing Gemma priorities; using speed and reliability'
    this.status.mode = 'fallback'
    return [...devices]
      .sort((a, b) => b.bytesPerSecond / (1 + b.failures) - a.bytesPerSecond / (1 + a.failures))
      .map((device) => device.id)
  }

  private async refresh(
    devices: DeviceMetrics[],
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    this.pending = true
    this.nextRefresh = Date.now() + 5_000
    try {
      const url = new URL(this.endpoint)
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        throw new Error('Use a local Ollama HTTP endpoint')
      // Model input has generated aliases and numerical telemetry only. No names, URLs or tokens.
      const ids = devices.map((_, index) => `device-${index}`)
      const response = await this.request(new URL('/api/chat', url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          options: { temperature: 0, num_predict: 128 },
          format: {
            type: 'object',
            properties: {
              priority: {
                type: 'array',
                items: { type: 'string', enum: ids },
                minItems: ids.length,
                maxItems: ids.length
              }
            },
            required: ['priority'],
            additionalProperties: false
          },
          messages: [
            {
              role: 'system',
              content:
                'Schedule parallel file downloads. Return JSON with priority: every device ID exactly once, best device first. Prefer higher measured end-to-end bytesPerSecond, fewer failures and enough remainingBytes. Zero speed means unmeasured, not disconnected. All devices may work concurrently; ranking decides who receives the next available chunk when devices compete. Do not include explanations.'
            },
            {
              role: 'user',
              content: JSON.stringify(
                devices.map((device, index) => ({ ...device, id: ids[index] }))
              )
            }
          ]
        })
      })
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`)
      // Bound the response even when a misconfigured local service ignores num_predict.
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Empty model response')
      let content = ''
      let length = 0
      const decoder = new TextDecoder()
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          length += part.value.byteLength
          if (length > 16_384) throw new Error('Model response too large')
          content += decoder.decode(part.value, { stream: true })
        }
        content += decoder.decode()
      } finally {
        await reader.cancel()
      }
      const result = JSON.parse(JSON.parse(content).message.content).priority
      if (
        !Array.isArray(result) ||
        result.length !== ids.length ||
        new Set(result).size !== ids.length ||
        result.some((id) => !ids.includes(id))
      )
        throw new Error('Invalid device priorities')
      if (signal.aborted || generation !== this.generation) return
      this.priority = result.map((id) => devices[ids.indexOf(id)].id)
      this.validUntil = Date.now() + 15_000
      this.status.mode = 'gemma'
      this.status.detail = `${this.model} chooses device priority`
    } catch {
      if (signal.aborted || generation !== this.generation) return
      this.priority = []
      this.validUntil = 0
      this.status.mode = 'fallback'
      this.status.detail = 'Gemma unavailable or invalid response; using speed and reliability'
    } finally {
      this.pending = false
    }
  }
}
