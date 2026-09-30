/** Versioned LAN protocol. A join code grants access; share it only with trusted people. */
export interface TogetherFile {
  protocol: 1
  id: string
  url: string
  fileName: string
  totalBytes: number
  etag: string
  expectedSha256?: string
}

export interface TogetherPeer {
  name: string
  bytes: number
  status: 'connected' | 'working' | 'left'
}

export interface TogetherState {
  role: 'host' | 'helper'
  status: 'waiting' | 'downloading' | 'verifying' | 'completed' | 'stopped' | 'error'
  file: TogetherFile
  code?: string
  bytes: number
  contributedBytes: number
  /** Source response payload received, including failed attempts; excludes network overhead. */
  usedBytes: number
  budgetBytes?: number
  peers: TogetherPeer[]
  destinationPath?: string
  sha256?: string
  error?: string
}

export interface HostTogetherRequest {
  url: string
  destinationDir: string
  internetInterfaceId: string
  lanAddress: string
  expectedSha256?: string
}

export interface JoinTogetherRequest {
  code: string
  file: TogetherFile
  name: string
  internetInterfaceId: string
  budgetBytes: number
}

export interface TogetherLease {
  id: string
  index: number
  start: number
  end: number
}
