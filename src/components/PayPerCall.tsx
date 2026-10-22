import { useState, useCallback, useEffect } from 'react'
import { useAccount, useReadContract, useSignTypedData } from 'wagmi'
import { formatUnits } from 'viem'
import {
  ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID, NETWORKS, TAB_ABI,
  tabDomain, VOUCHER_TYPES, formatAddr,
} from '@/tabContract'
import { Copy, Check, Zap } from 'lucide-react'
import { toast } from 'sonner'

interface CallLogEntry {
  callNum: number
  cumulative: bigint
  signature: string
  timestamp: string
}

interface VoucherStore {
  [tabId: string]: { cumulative: string; signature: string }
}

function getVoucherStore(): VoucherStore {
  try { return JSON.parse(localStorage.getItem('tab-vouchers') ?? '{}') as VoucherStore } catch { return {} }
}
function setVoucherInStore(tabId: string, cumulative: bigint, signature: string) {
  const store = getVoucherStore()
  store[tabId] = { cumulative: cumulative.toString(), signature }
  localStorage.setItem('tab-vouchers', JSON.stringify(store))
}

export function PayPerCall() {
  const { address, chainId, isConnected } = useAccount()

  const supported = chainId === ARC_TESTNET_CHAIN_ID || chainId === ARC_MAINNET_CHAIN_ID
  const net = supported ? NETWORKS[chainId] : null

  const [tabIdStr, setTabIdStr] = useState('')
  const [pricePerCall, setPricePerCall] = useState('0.001')
  const [callLog, setCallLog] = useState<CallLogEntry[]>([])
  const [currentCumulative, setCurrentCumulative] = useState(0n)
  const [apiResult, setApiResult] = useState<string | null>(null)
  const [calling, setCalling] = useState(false)
  const [copied, setCopied] = useState(false)

  const tabId = (() => { try { return tabIdStr ? BigInt(tabIdStr) : null } catch { return null } })()

  // Read tab state
  const { data: tabInfo, refetch: refetchTab } = useReadContract({
    address: net?.tabAddress as `0x${string}` | undefined,
    abi: TAB_ABI,
    functionName: 'tabs',
    args: tabId !== null ? [tabId] : undefined,
    chainId: chainId as 5042002 | 5042,
    query: { enabled: !!net?.tabAddress && tabId !== null },
  })

  const tabData = tabInfo as [string, string, bigint, bigint, bigint, boolean] | undefined

  // Load last cumulative from localStorage when tab changes
  useEffect(() => {
    const store = getVoucherStore()
    const saved = tabId !== null ? store[tabId.toString()] : undefined
    setCurrentCumulative(saved ? BigInt(saved.cumulative) : 0n)
    setCallLog([])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdStr]) // intentionally keyed on the raw string, not parsed tabId

  const { signTypedDataAsync } = useSignTypedData()

  const parsedPrice = (() => {
    try {
      const parts = pricePerCall.split('.')
      const intPart = BigInt(parts[0] || '0')
      const decStr = (parts[1] ?? '').padEnd(6, '0').slice(0, 6)
      return intPart * 1_000_000n + BigInt(decStr)
    } catch { return 0n }
  })()

  const handleCall = useCallback(async () => {
    if (!net?.tabAddress || tabId === null || !address || parsedPrice === 0n) return
    setCalling(true)
    setApiResult(null)

    let timeStr = new Date().toISOString()
    try {
      const res = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', { signal: AbortSignal.timeout(4000) })
      const json = await res.json() as { datetime?: string }
      if (json.datetime) timeStr = json.datetime
    } catch {
      timeStr = new Date().toISOString()
    }

    const nextCumulative = currentCumulative + parsedPrice

    // Check against deposit
    if (tabData) {
      const deposit = tabData[2]
      if (nextCumulative > deposit) {
        toast.error('Cumulative would exceed deposit. Top up or open a new tab.')
        setCalling(false)
        return
      }
    }

    try {
      const signature = await signTypedDataAsync({
        domain: tabDomain(net),
        types: VOUCHER_TYPES,
        primaryType: 'Voucher',
        message: { tabId, cumulative: nextCumulative },
      })

      setCurrentCumulative(nextCumulative)
      setVoucherInStore(tabId.toString(), nextCumulative, signature)
      setApiResult(timeStr)

      const entry: CallLogEntry = {
        callNum: callLog.length + 1,
        cumulative: nextCumulative,
        signature,
        timestamp: new Date().toLocaleTimeString(),
      }
      setCallLog(prev => [...prev, entry])
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('user rejected')) {
        toast.error('Signing failed')
      }
    } finally {
      setCalling(false)
      void refetchTab()
    }
  }, [net, tabId, address, parsedPrice, currentCumulative, callLog.length, tabData, signTypedDataAsync, refetchTab])

  function handleCopyVoucher() {
    if (tabId === null) return
    const store = getVoucherStore()
    const saved = store[tabId.toString()]
    if (!saved) { toast.error('No voucher yet — make a call first'); return }
    const json = JSON.stringify({ tabId: tabId.toString(), cumulative: saved.cumulative, signature: saved.signature }, null, 2)
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success('Voucher copied')
    })
  }

  if (!isConnected) return <EmptyState message="Connect your wallet to use Pay per Call." />
  if (!supported) return <EmptyState message="Switch to Arc Testnet or Arc Mainnet." />
  if (!net!.tabAddress) return <EmptyState message="Tab is not deployed on this network." />

  const deposit = tabData ? tabData[2] : null
  const settled = tabData ? tabData[3] : null
  const isClosed = tabData ? tabData[5] : false

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        Pick a tab you opened. Each button click signs a cumulative voucher off-chain — no gas, instant. Copy the latest voucher for the service to redeem.
      </p>

      <div className="space-y-3">
        {/* Tab ID */}
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Tab ID</label>
          <input
            value={tabIdStr}
            onChange={e => setTabIdStr(e.target.value)}
            placeholder="0"
            type="number"
            min="0"
            className="w-full rounded-lg px-3 py-2 text-sm mono outline-none"
            style={{
              background: 'var(--surface-muted)',
              border: '1px solid var(--border)',
              color: 'var(--ink)',
              fontFamily: 'inherit',
            }}
          />
        </div>

        {/* Tab state */}
        {tabData && tabId !== null && (
          <div className="rounded-lg px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
               style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--muted)' }}>Payer</span>
            <span className="mono text-right truncate" style={{ color: 'var(--ink)' }}>{formatAddr(tabData[0])}</span>
            <span style={{ color: 'var(--muted)' }}>Payee</span>
            <span className="mono text-right truncate" style={{ color: 'var(--ink)' }}>{formatAddr(tabData[1])}</span>
            <span style={{ color: 'var(--muted)' }}>Deposit</span>
            <span className="mono text-right tabular-nums" style={{ color: 'var(--ink)' }}>{formatUnits(deposit!, 6)} USDC</span>
            <span style={{ color: 'var(--muted)' }}>Settled</span>
            <span className="mono text-right tabular-nums" style={{ color: 'var(--ink)' }}>{formatUnits(settled!, 6)} USDC</span>
            {isClosed && <span className="col-span-2 text-center text-xs font-medium" style={{ color: 'var(--danger)' }}>Tab closed</span>}
          </div>
        )}

        {/* Price per call */}
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>
            Price per call (USDC)
          </label>
          <input
            value={pricePerCall}
            onChange={e => setPricePerCall(e.target.value)}
            type="number"
            min="0.000001"
            step="0.000001"
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={{
              background: 'var(--surface-muted)',
              border: '1px solid var(--border)',
              color: 'var(--ink)',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
        </div>
      </div>

      {/* Cumulative tracker */}
      {tabId !== null && (
        <div className="rounded-lg px-4 py-3 text-xs flex items-center justify-between"
             style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--muted)' }}>Cumulative owed</span>
          <span className="mono tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>
            {formatUnits(currentCumulative, 6)} USDC
          </span>
        </div>
      )}

      {/* Call button */}
      <button
        onClick={() => void handleCall()}
        disabled={calling || tabId === null || isClosed || parsedPrice === 0n}
        className="w-full rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2 transition-colors"
        style={{
          background: (calling || tabId === null || isClosed || parsedPrice === 0n)
            ? 'var(--surface-muted)' : 'var(--accent)',
          color: (calling || tabId === null || isClosed || parsedPrice === 0n)
            ? 'var(--muted)' : '#fff',
        }}
      >
        <Zap size={16} />
        {calling ? 'Signing voucher…' : 'Call the API'}
      </button>

      {/* API result */}
      {apiResult && (
        <div className="rounded-lg px-3 py-2 text-xs mono" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
          UTC time: <span style={{ color: 'var(--ink)' }}>{apiResult}</span>
        </div>
      )}

      {/* Copy latest voucher */}
      {callLog.length > 0 && (
        <button
          onClick={handleCopyVoucher}
          className="w-full rounded-xl py-2.5 font-medium text-sm flex items-center justify-center gap-2 transition-colors"
          style={{
            background: 'var(--surface-muted)',
            border: '1px solid var(--border)',
            color: 'var(--ink)',
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied!' : 'Copy latest voucher JSON'}
        </button>
      )}

      {/* Call log */}
      {callLog.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Call log</div>
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {callLog.map((entry, i) => (
              <div
                key={i}
                className="px-4 py-2.5 text-xs grid gap-1"
                style={{
                  borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                  background: 'var(--surface-muted)',
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold" style={{ color: 'var(--ink)' }}>Call #{entry.callNum}</span>
                  <span style={{ color: 'var(--subtle)' }}>{entry.timestamp}</span>
                </div>
                <div className="flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                  <span>Cumulative:</span>
                  <span className="mono tabular-nums font-medium" style={{ color: 'var(--ink)' }}>
                    {formatUnits(entry.cumulative, 6)} USDC
                  </span>
                </div>
                <div className="mono truncate" style={{ color: 'var(--subtle)', fontSize: '0.65rem' }}>
                  sig: {entry.signature.slice(0, 14)}…{entry.signature.slice(-8)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return <div className="py-8 text-center text-sm" style={{ color: 'var(--muted)' }}>{message}</div>
}
