import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { parseAbiItem, formatUnits, isAddress } from 'viem'
import {
  ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID, NETWORKS,
  buildExplorerTxUrl, formatAddr,
} from '@/tabContract'
import { ExternalLink, RefreshCw, ChevronDown } from 'lucide-react'

interface TabEvent {
  type: 'TabOpened' | 'Settled' | 'Closed'
  tabId: string
  blockNumber: bigint
  txHash: string
  detail: string
}

const TAB_OPENED_ABI = parseAbiItem('event TabOpened(uint256 indexed tabId, address indexed payer, address indexed payee, uint128 amount, uint64 expiry)')
const SETTLED_ABI    = parseAbiItem('event Settled(uint256 indexed tabId, uint128 cumulative, uint128 paid)')
const CLOSED_ABI     = parseAbiItem('event Closed(uint256 indexed tabId, uint128 refund)')

/** Maximum blocks per getLogs call. Arc rejects > ~5 000. */
const WINDOW_SIZE = 5_000n
/** How many windows to fetch in a single batch (parallel). */
const BATCH_SIZE  = 6
/** Maximum windows before we stop and show "Load older". */
const MAX_WINDOWS = 60

/** Fetch all three event types for one block window, with one retry on -32014. */
async function fetchWindow(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  contractAddress: `0x${string}`,
  from: bigint,
  to: bigint,
): Promise<{ opened: unknown[]; settled: unknown[]; closed: unknown[] }> {
  async function attempt() {
    const [opened, settled, closed] = await Promise.all([
      client.getLogs({ address: contractAddress, event: TAB_OPENED_ABI, fromBlock: from, toBlock: to }),
      client.getLogs({ address: contractAddress, event: SETTLED_ABI,    fromBlock: from, toBlock: to }),
      client.getLogs({ address: contractAddress, event: CLOSED_ABI,     fromBlock: from, toBlock: to }),
    ])
    return { opened, settled, closed }
  }

  try {
    return await attempt()
  } catch (e: unknown) {
    // -32014: load-balanced node at a lower height — wait and retry once
    const code = (e as { code?: number })?.code
    if (code === -32014) {
      await new Promise(r => setTimeout(r, 500))
      return attempt()
    }
    throw e
  }
}

export function TabEvents() {
  const { address, chainId, isConnected } = useAccount()
  const publicClient = usePublicClient({ chainId: chainId as 5042002 | 5042 })

  const supported = chainId === ARC_TESTNET_CHAIN_ID || chainId === ARC_MAINNET_CHAIN_ID
  const net = supported ? NETWORKS[chainId] : null

  const [lookupAddr, setLookupAddr] = useState('')
  const [events, setEvents] = useState<TabEvent[]>([])
  /** Lowest block already scanned (exclusive lower bound for "Load older"). */
  const [scanFloor, setScanFloor]   = useState<bigint | null>(null)
  /** Total range being scanned in this run (head − deployBlock). */
  const [totalBlocks, setTotalBlocks] = useState<bigint>(0n)
  /** How many blocks have been scanned so far. */
  const [scannedBlocks, setScannedBlocks] = useState<bigint>(0n)
  const [loading, setLoading]       = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError]           = useState('')
  const [hasMore, setHasMore]       = useState(false)
  /** Bump to re-run the full scan from head. */
  const [refreshTick, setRefreshTick] = useState(0)

  // Use a ref so the effect cleanup can signal cancellation without a stale closure
  const cancelRef = useRef(false)

  const targetAddr = lookupAddr.trim()
    ? (isAddress(lookupAddr.trim()) ? lookupAddr.trim().toLowerCase() : null)
    : address?.toLowerCase() ?? null

  const lookupAddrInvalid = lookupAddr.trim().length > 0 && !isAddress(lookupAddr.trim())

  /**
   * Scan `batchCount` windows backwards from `startBlock` (inclusive upper bound).
   * Runs windows in parallel groups of BATCH_SIZE.
   * Returns the collected events and the new floor.
   */
  const scanBatch = useCallback(async (
    startBlock: bigint,
    batchCount: number,
    onProgress: (scanned: bigint) => void,
  ): Promise<{ newEvents: TabEvent[]; newFloor: bigint; exhausted: boolean }> => {
    if (!net?.tabAddress || !publicClient) return { newEvents: [], newFloor: startBlock, exhausted: true }

    const contractAddress = net.tabAddress
    const deployBlock = net.deployBlock
    const collected: TabEvent[] = []
    let cursor = startBlock
    let windowsDone = 0
    let progressAccum = 0n

    while (windowsDone < batchCount) {
      if (cancelRef.current) break
      if (cursor < deployBlock) break

      // Build a parallel group of up to BATCH_SIZE windows
      const group: Array<{ from: bigint; to: bigint }> = []
      let c = cursor
      for (let i = 0; i < BATCH_SIZE && windowsDone + i < batchCount; i++) {
        const to   = c
        const from = to >= WINDOW_SIZE ? to - WINDOW_SIZE + 1n : deployBlock
        group.push({ from: from < deployBlock ? deployBlock : from, to })
        if (from <= deployBlock) break
        c = from - 1n
      }

      // Fetch all windows in the group concurrently
      const results = await Promise.all(
        group.map(w => fetchWindow(publicClient, contractAddress, w.from, w.to)),
      )

      if (cancelRef.current) break

      for (let i = 0; i < group.length; i++) {
        const { opened, settled, closed } = results[i]
        const { from, to } = group[i]
        progressAccum += to - from + 1n

        for (const log of opened as RawLog[]) {
          const ev = parseOpenedLog(log, targetAddr ?? '')
          if (ev) collected.push(ev)
        }
        for (const log of settled as RawLog[]) {
          collected.push(parseSettledLog(log))
        }
        for (const log of closed as RawLog[]) {
          collected.push(parseClosedLog(log))
        }

        windowsDone++
        cursor = from - 1n
      }

      onProgress(progressAccum)
      progressAccum = 0n
    }

    const exhausted = cursor < deployBlock
    return { newEvents: collected, newFloor: cursor, exhausted }
  }, [net, publicClient, targetAddr])

  // Full scan from head — triggered by refreshTick or dependency changes
  useEffect(() => {
    if (lookupAddrInvalid || !targetAddr || !net?.tabAddress || !publicClient) return

    cancelRef.current = false
    setLoading(true)
    setError('')
    setEvents([])
    setScanFloor(null)
    setTotalBlocks(0n)
    setScannedBlocks(0n)
    setHasMore(false)

    let didRun = false

    publicClient.getBlockNumber().then(async head => {
      if (cancelRef.current) return
      didRun = true

      const total = head - net.deployBlock + 1n
      setTotalBlocks(total > 0n ? total : 1n)

      const { newEvents, newFloor, exhausted } = await scanBatch(
        head,
        MAX_WINDOWS,
        scanned => setScannedBlocks(prev => prev + scanned),
      )
      if (cancelRef.current) return

      newEvents.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1))
      setEvents(newEvents)
      setScanFloor(newFloor)
      setHasMore(!exhausted)
    }).catch((e: unknown) => {
      if (cancelRef.current) return
      const msg = e instanceof Error ? e.message : String(e)
      setError(`Could not fetch events: ${msg.slice(0, 120)}`)
    }).finally(() => {
      if (!cancelRef.current || !didRun) setLoading(false)
    })

    return () => { cancelRef.current = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetAddr, net, publicClient, lookupAddrInvalid, refreshTick])

  const handleRefresh = useCallback(() => setRefreshTick(t => t + 1), [])

  const handleLoadOlder = useCallback(() => {
    if (!scanFloor || !net?.tabAddress || !publicClient || loadingOlder) return
    if (scanFloor < net.deployBlock) return

    setLoadingOlder(true)
    setError('')

    scanBatch(scanFloor, MAX_WINDOWS, () => {}).then(({ newEvents, newFloor, exhausted }) => {
      if (cancelRef.current) return
      setEvents(prev => {
        const merged = [...prev, ...newEvents]
        merged.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1))
        return merged
      })
      setScanFloor(newFloor)
      setHasMore(!exhausted)
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`Could not load older events: ${msg.slice(0, 120)}`)
    }).finally(() => {
      setLoadingOlder(false)
    })
  }, [scanFloor, net, publicClient, loadingOlder, scanBatch])

  if (!isConnected && !lookupAddr) return null
  if (!supported || !net?.tabAddress) return null

  const typeColor = (type: TabEvent['type']) => {
    if (type === 'TabOpened') return 'var(--accent-hover)'
    if (type === 'Settled') return 'var(--success)'
    return 'var(--muted)'
  }
  const typeLabel = (type: TabEvent['type']) => {
    if (type === 'TabOpened') return 'Opened'
    if (type === 'Settled') return 'Settled'
    return 'Closed'
  }

  const progressPct = totalBlocks > 0n
    ? Math.min(100, Number((scannedBlocks * 100n) / totalBlocks))
    : 0

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Tabs</h2>
        <button
          onClick={handleRefresh}
          disabled={loading || lookupAddrInvalid}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg"
          style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      {/* Address lookup */}
      <div className="mb-3">
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>
          Look up an address
        </label>
        <input
          value={lookupAddr}
          onChange={e => setLookupAddr(e.target.value)}
          placeholder={address ?? '0x… (defaults to connected wallet)'}
          className="mono w-full rounded-lg px-3 py-2 text-xs outline-none transition-colors"
          style={{
            background: 'var(--surface-muted)',
            border: lookupAddrInvalid ? '1px solid var(--danger)' : '1px solid var(--border)',
            color: 'var(--ink)',
          }}
        />
        {lookupAddrInvalid && (
          <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>Enter a valid 0x address</p>
        )}
      </div>

      {/* Scan progress */}
      {loading && totalBlocks > 0n && (
        <div className="mb-3 space-y-1">
          <div className="flex justify-between text-xs" style={{ color: 'var(--subtle)' }}>
            <span>Scanning blocks…</span>
            <span className="mono tabular-nums">{scannedBlocks.toString()} / {totalBlocks.toString()}</span>
          </div>
          <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
            <div
              className="h-1 rounded-full transition-all"
              style={{ width: `${progressPct}%`, background: 'var(--accent)' }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs py-2" style={{ color: 'var(--danger)' }}>{error}</div>
      )}

      {!loading && events.length === 0 && !error && targetAddr && (
        <div className="text-xs py-4 text-center" style={{ color: 'var(--subtle)' }}>
          No tabs found for {formatAddr(targetAddr)}.
        </div>
      )}

      {events.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {events.map((ev, i) => (
            <div
              key={`${ev.txHash}-${i}`}
              className="px-4 py-3 flex items-start justify-between gap-3 text-xs"
              style={{
                borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                background: 'var(--surface-muted)',
              }}
            >
              <div className="space-y-0.5 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold" style={{ color: typeColor(ev.type) }}>
                    {typeLabel(ev.type)}
                  </span>
                  <span className="mono" style={{ color: 'var(--subtle)' }}>Tab #{ev.tabId}</span>
                </div>
                <div className="mono tabular-nums" style={{ color: 'var(--muted)' }}>{ev.detail}</div>
                {ev.txHash && (
                  <div className="mono truncate" style={{ color: 'var(--subtle)', fontSize: '0.65rem' }}>
                    {formatAddr(ev.txHash)}
                  </div>
                )}
              </div>
              {ev.txHash && (
                <a
                  href={buildExplorerTxUrl(net.explorerBase, ev.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--subtle)', flexShrink: 0 }}
                >
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Load older */}
      {hasMore && !loading && (
        <button
          onClick={handleLoadOlder}
          disabled={loadingOlder}
          className="mt-3 w-full flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-medium transition-colors"
          style={{
            background: 'var(--surface-muted)',
            border: '1px solid var(--border)',
            color: loadingOlder ? 'var(--subtle)' : 'var(--muted)',
          }}
        >
          <ChevronDown size={13} className={loadingOlder ? 'animate-bounce' : ''} />
          {loadingOlder ? 'Loading…' : 'Load older'}
        </button>
      )}
    </div>
  )
}

// ─── Log parsers ──────────────────────────────────────────────────────────────

type RawLog = { args: Record<string, unknown>; blockNumber?: bigint | null; transactionHash?: string | null }

function parseOpenedLog(log: RawLog, targetAddr: string): TabEvent | null {
  const args = log.args as { tabId?: bigint; payer?: string; payee?: string; amount?: bigint }
  const payer = args.payer?.toLowerCase()
  const payee = args.payee?.toLowerCase()
  if (targetAddr && payer !== targetAddr && payee !== targetAddr) return null
  return {
    type: 'TabOpened',
    tabId: args.tabId?.toString() ?? '?',
    blockNumber: log.blockNumber ?? 0n,
    txHash: log.transactionHash ?? '',
    detail: `${formatUnits(args.amount ?? 0n, 6)} USDC  •  ${payer === targetAddr ? 'you opened' : 'opened for you'}`,
  }
}

function parseSettledLog(log: RawLog): TabEvent {
  const args = log.args as { tabId?: bigint; cumulative?: bigint; paid?: bigint }
  return {
    type: 'Settled',
    tabId: args.tabId?.toString() ?? '?',
    blockNumber: log.blockNumber ?? 0n,
    txHash: log.transactionHash ?? '',
    detail: `paid ${formatUnits(args.paid ?? 0n, 6)} USDC  •  cumulative ${formatUnits(args.cumulative ?? 0n, 6)} USDC`,
  }
}

function parseClosedLog(log: RawLog): TabEvent {
  const args = log.args as { tabId?: bigint; refund?: bigint }
  return {
    type: 'Closed',
    tabId: args.tabId?.toString() ?? '?',
    blockNumber: log.blockNumber ?? 0n,
    txHash: log.transactionHash ?? '',
    detail: `refund ${formatUnits(args.refund ?? 0n, 6)} USDC`,
  }
}
