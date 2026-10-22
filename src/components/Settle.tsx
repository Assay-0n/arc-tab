import { useState, useEffect } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { formatUnits } from 'viem'
import { verifyTypedData } from 'viem'
import {
  ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID, NETWORKS, TAB_ABI,
  tabDomain, VOUCHER_TYPES, formatAddr, buildExplorerTxUrl,
} from '@/tabContract'
import { ExternalLink, CheckCircle, XCircle } from 'lucide-react'
import { toast } from 'sonner'

interface Voucher {
  tabId: string
  cumulative: string
  signature: string
}

function getLatestVoucher(tabId: string): Voucher | null {
  try {
    const store = JSON.parse(localStorage.getItem('tab-vouchers') ?? '{}') as Record<string, { cumulative: string; signature: string }>
    const saved = store[tabId]
    if (!saved) return null
    return { tabId, ...saved }
  } catch { return null }
}

export function Settle() {
  const { chainId, isConnected } = useAccount()

  const supported = chainId === ARC_TESTNET_CHAIN_ID || chainId === ARC_MAINNET_CHAIN_ID
  const net = supported ? NETWORKS[chainId] : null

  const [voucherJson, setVoucherJson] = useState('')
  const [voucher, setVoucher] = useState<Voucher | null>(null)
  const [parseError, setParseError] = useState('')
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; delta: bigint } | null>(null)
  const [reclaimTabId, setReclaimTabId] = useState('')
  // Stable timestamp captured at mount — used only for expiry display
  const [mountNow] = useState(() => Date.now())

  const tabId = (() => {
    try { return voucher ? BigInt(voucher.tabId) : null } catch { return null }
  })()

  const reclaimTabIdBig = (() => {
    try { return reclaimTabId ? BigInt(reclaimTabId) : null } catch { return null }
  })()

  // Read tab state for settle
  const { data: tabInfo, refetch: refetchTab } = useReadContract({
    address: net?.tabAddress as `0x${string}` | undefined,
    abi: TAB_ABI,
    functionName: 'tabs',
    args: tabId !== null ? [tabId] : undefined,
    chainId: chainId as 5042002 | 5042,
    query: { enabled: !!net?.tabAddress && tabId !== null },
  })

  // Read tab state for reclaim
  const { data: reclaimTabInfo } = useReadContract({
    address: net?.tabAddress as `0x${string}` | undefined,
    abi: TAB_ABI,
    functionName: 'tabs',
    args: reclaimTabIdBig !== null ? [reclaimTabIdBig] : undefined,
    chainId: chainId as 5042002 | 5042,
    query: { enabled: !!net?.tabAddress && reclaimTabIdBig !== null },
  })

  const tabData = tabInfo as [string, string, bigint, bigint, bigint, boolean] | undefined
  const reclaimTabData = reclaimTabInfo as [string, string, bigint, bigint, bigint, boolean] | undefined

  // Settle
  const { writeContract: doSettle, data: settleTxHash, isPending: settleWaiting, reset: resetSettle } = useWriteContract()
  const { isLoading: settleConfirming, isSuccess: settleSuccess } = useWaitForTransactionReceipt({ hash: settleTxHash })

  // SettleAndClose
  const { writeContract: doSettleAndClose, data: sacTxHash, isPending: sacWaiting, reset: resetSac } = useWriteContract()
  const { isLoading: sacConfirming, isSuccess: sacSuccess } = useWaitForTransactionReceipt({ hash: sacTxHash })

  // Reclaim
  const { writeContract: doReclaim, data: reclaimTxHash, isPending: reclaimWaiting, reset: resetReclaim } = useWriteContract()
  const { isLoading: reclaimConfirming, isSuccess: reclaimSuccess } = useWaitForTransactionReceipt({ hash: reclaimTxHash })

  // Refresh tab after settle actions
  useEffect(() => {
    if (settleSuccess || sacSuccess) void refetchTab()
  }, [settleSuccess, sacSuccess, refetchTab])

  function parseVoucher(raw: string) {
    setVerifyResult(null)
    try {
      const parsed = JSON.parse(raw) as Voucher
      if (!parsed.tabId || !parsed.cumulative || !parsed.signature) throw new Error('Missing fields')
      setVoucher(parsed)
      setParseError('')
    } catch {
      setVoucher(null)
      setParseError('Invalid JSON — expected {tabId, cumulative, signature}')
    }
  }

  function loadLatest() {
    if (!tabId) {
      toast.error('Enter a Tab ID first')
      return
    }
    const v = getLatestVoucher(tabId.toString())
    if (!v) { toast.error('No local voucher for this tab'); return }
    const json = JSON.stringify(v, null, 2)
    setVoucherJson(json)
    parseVoucher(json)
  }

  async function handleVerify() {
    if (!voucher || !tabData || !net?.tabAddress) return
    try {
      const cumulative = BigInt(voucher.cumulative)
      const payer = tabData[0] as `0x${string}`
      const settled = tabData[3]

      const valid = await verifyTypedData({
        address: payer,
        domain: tabDomain(net),
        types: VOUCHER_TYPES,
        primaryType: 'Voucher',
        message: { tabId: tabId!, cumulative },
        signature: voucher.signature as `0x${string}`,
      })

      const delta = cumulative > settled ? cumulative - settled : 0n
      setVerifyResult({ valid, delta })
    } catch {
      setVerifyResult({ valid: false, delta: 0n })
    }
  }

  function handleSettle() {
    if (!net?.tabAddress || !voucher || tabId === null) return
    doSettle({
      address: net.tabAddress,
      abi: TAB_ABI,
      functionName: 'settle',
      args: [tabId, BigInt(voucher.cumulative), voucher.signature as `0x${string}`],
      chainId: chainId as 5042002 | 5042,
    })
  }

  function handleSettleAndClose() {
    if (!net?.tabAddress || !voucher || tabId === null) return
    doSettleAndClose({
      address: net.tabAddress,
      abi: TAB_ABI,
      functionName: 'settleAndClose',
      args: [tabId, BigInt(voucher.cumulative), voucher.signature as `0x${string}`],
      chainId: chainId as 5042002 | 5042,
    })
  }

  function handleReclaim() {
    if (!net?.tabAddress || reclaimTabIdBig === null) return
    doReclaim({
      address: net.tabAddress,
      abi: TAB_ABI,
      functionName: 'reclaim',
      args: [reclaimTabIdBig],
      chainId: chainId as 5042002 | 5042,
    })
  }

  if (!isConnected) return <EmptyState message="Connect your wallet to settle or reclaim." />
  if (!supported) return <EmptyState message="Switch to Arc Testnet or Arc Mainnet." />
  if (!net!.tabAddress) return <EmptyState message="Tab is not deployed on this network." />

  const expiryTs = tabData ? Number(tabData[4]) * 1000 : 0
  const isExpired = expiryTs > 0 && mountNow > expiryTs
  const isClosed = tabData ? tabData[5] : false

  return (
    <div className="space-y-6">

      {/* Settle section */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Redeem a voucher</h3>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Paste the voucher JSON from the client (or load the latest local one). Verify the signature, then settle.
        </p>

        {/* Voucher paste */}
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Voucher JSON</label>
          <textarea
            value={voucherJson}
            onChange={e => { setVoucherJson(e.target.value); parseVoucher(e.target.value) }}
            rows={4}
            placeholder={'{"tabId":"0","cumulative":"1000","signature":"0x…"}'}
            className="w-full rounded-lg px-3 py-2 text-xs mono outline-none resize-y"
            style={{
              background: 'var(--surface-muted)',
              border: '1px solid var(--border)',
              color: 'var(--ink)',
            }}
          />
          {parseError && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{parseError}</p>}
        </div>

        <button
          onClick={loadLatest}
          className="text-xs underline"
          style={{ color: 'var(--accent-hover)' }}
        >
          Load latest local voucher
        </button>

        {/* Tab state */}
        {tabData && tabId !== null && (
          <div className="rounded-lg px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
               style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--muted)' }}>Payer</span>
            <span className="mono text-right truncate" style={{ color: 'var(--ink)' }}>{formatAddr(tabData[0])}</span>
            <span style={{ color: 'var(--muted)' }}>Payee</span>
            <span className="mono text-right truncate" style={{ color: 'var(--ink)' }}>{formatAddr(tabData[1])}</span>
            <span style={{ color: 'var(--muted)' }}>Deposit</span>
            <span className="mono text-right tabular-nums" style={{ color: 'var(--ink)' }}>{formatUnits(tabData[2], 6)} USDC</span>
            <span style={{ color: 'var(--muted)' }}>Settled</span>
            <span className="mono text-right tabular-nums" style={{ color: 'var(--ink)' }}>{formatUnits(tabData[3], 6)} USDC</span>
            <span style={{ color: 'var(--muted)' }}>Remaining</span>
            <span className="mono text-right tabular-nums" style={{ color: 'var(--ink)' }}>
              {formatUnits(tabData[2] - tabData[3], 6)} USDC
            </span>
            <span style={{ color: 'var(--muted)' }}>Expiry</span>
            <span className="text-right" style={{ color: isExpired ? 'var(--danger)' : 'var(--ink)' }}>
              {expiryTs ? new Date(expiryTs).toLocaleString() : '—'}
              {isExpired ? ' (expired)' : ''}
            </span>
            {isClosed && (
              <span className="col-span-2 text-center font-medium" style={{ color: 'var(--danger)' }}>Tab closed</span>
            )}
          </div>
        )}

        {/* Verify */}
        <button
          onClick={() => void handleVerify()}
          disabled={!voucher || !tabData}
          className="w-full rounded-xl py-2.5 font-medium text-sm transition-colors"
          style={{
            background: (!voucher || !tabData) ? 'var(--surface-muted)' : 'var(--surface-muted)',
            border: '1px solid var(--border)',
            color: (!voucher || !tabData) ? 'var(--subtle)' : 'var(--ink)',
          }}
        >
          Verify signature
        </button>

        {verifyResult && (
          <div
            className="rounded-lg px-4 py-3 flex items-center justify-between text-sm"
            style={{
              background: verifyResult.valid ? '#f0faf4' : '#fef2f2',
              border: `1px solid ${verifyResult.valid ? '#c6e8d5' : '#fecaca'}`,
            }}
          >
            <div className="flex items-center gap-2">
              {verifyResult.valid
                ? <CheckCircle size={16} style={{ color: 'var(--success)' }} />
                : <XCircle size={16} style={{ color: 'var(--danger)' }} />
              }
              <span style={{ color: verifyResult.valid ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>
                {verifyResult.valid ? 'Valid' : 'Invalid signature'}
              </span>
            </div>
            {verifyResult.valid && (
              <span className="mono tabular-nums text-xs font-medium" style={{ color: 'var(--success)' }}>
                pays {formatUnits(verifyResult.delta, 6)} USDC
              </span>
            )}
          </div>
        )}

        {/* Settle / SettleAndClose */}
        <div className="flex gap-2">
          <button
            onClick={() => { resetSettle(); handleSettle() }}
            disabled={!voucher || isClosed || settleWaiting || settleConfirming}
            className="flex-1 rounded-xl py-3 font-semibold text-sm transition-colors"
            style={{
              background: (!voucher || isClosed || settleWaiting || settleConfirming)
                ? 'var(--surface-muted)' : 'var(--accent)',
              color: (!voucher || isClosed || settleWaiting || settleConfirming) ? 'var(--muted)' : '#fff',
            }}
          >
            {settleWaiting ? 'Confirm…' : settleConfirming ? 'Settling…' : 'Settle'}
          </button>
          <button
            onClick={() => { resetSac(); handleSettleAndClose() }}
            disabled={!voucher || isClosed || sacWaiting || sacConfirming}
            className="flex-1 rounded-xl py-3 font-semibold text-sm transition-colors"
            style={{
              background: (!voucher || isClosed || sacWaiting || sacConfirming)
                ? 'var(--surface-muted)' : 'var(--ink-2)',
              color: (!voucher || isClosed || sacWaiting || sacConfirming) ? 'var(--muted)' : '#fff',
            }}
          >
            {sacWaiting ? 'Confirm…' : sacConfirming ? 'Closing…' : 'Settle + close'}
          </button>
        </div>

        {/* Settle success */}
        {(settleSuccess || sacSuccess) && (
          <div className="rounded-lg px-4 py-3 text-sm flex items-center justify-between"
               style={{ background: '#f0faf4', border: '1px solid #c6e8d5' }}>
            <span style={{ color: 'var(--success)', fontWeight: 600 }}>
              {sacSuccess ? 'Settled and closed' : 'Settled'}
            </span>
            {(settleTxHash || sacTxHash) && (
              <a
                href={buildExplorerTxUrl(net!.explorerBase, (settleTxHash ?? sacTxHash)!)}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs"
                style={{ color: 'var(--accent-hover)' }}
              >
                Explorer <ExternalLink size={12} />
              </a>
            )}
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid var(--border)' }} />

      {/* Reclaim section */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Reclaim deposit (after expiry)</h3>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Payer only. After the tab expires, reclaim the unspent deposit.
        </p>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Tab ID</label>
          <input
            value={reclaimTabId}
            onChange={e => setReclaimTabId(e.target.value)}
            placeholder="0"
            type="number"
            min="0"
            className="w-full rounded-lg px-3 py-2 text-sm mono outline-none"
            style={{
              background: 'var(--surface-muted)',
              border: '1px solid var(--border)',
              color: 'var(--ink)',
            }}
          />
        </div>

        {reclaimTabData && reclaimTabIdBig !== null && (
          <div className="rounded-lg px-4 py-3 text-xs" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
            <div className="flex justify-between">
              <span style={{ color: 'var(--muted)' }}>Deposit</span>
              <span className="mono tabular-nums" style={{ color: 'var(--ink)' }}>{formatUnits(reclaimTabData[2], 6)} USDC</span>
            </div>
            <div className="flex justify-between mt-1">
              <span style={{ color: 'var(--muted)' }}>Settled</span>
              <span className="mono tabular-nums" style={{ color: 'var(--ink)' }}>{formatUnits(reclaimTabData[3], 6)} USDC</span>
            </div>
            <div className="flex justify-between mt-1 font-semibold">
              <span style={{ color: 'var(--muted)' }}>Refund</span>
              <span className="mono tabular-nums" style={{ color: 'var(--success)' }}>
                {formatUnits(reclaimTabData[2] - reclaimTabData[3], 6)} USDC
              </span>
            </div>
          </div>
        )}

        <button
          onClick={() => { resetReclaim(); handleReclaim() }}
          disabled={reclaimTabIdBig === null || reclaimWaiting || reclaimConfirming}
          className="w-full rounded-xl py-3 font-semibold text-sm transition-colors"
          style={{
            background: (reclaimTabIdBig === null || reclaimWaiting || reclaimConfirming)
              ? 'var(--surface-muted)' : 'var(--accent)',
            color: (reclaimTabIdBig === null || reclaimWaiting || reclaimConfirming) ? 'var(--muted)' : '#fff',
          }}
        >
          {reclaimWaiting ? 'Confirm in wallet…' : reclaimConfirming ? 'Reclaiming…' : 'Reclaim'}
        </button>

        {reclaimSuccess && reclaimTxHash && (
          <div className="rounded-lg px-4 py-3 text-sm flex items-center justify-between"
               style={{ background: '#f0faf4', border: '1px solid #c6e8d5' }}>
            <span style={{ color: 'var(--success)', fontWeight: 600 }}>Reclaimed</span>
            <a
              href={buildExplorerTxUrl(net!.explorerBase, reclaimTxHash)}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs"
              style={{ color: 'var(--accent-hover)' }}
            >
              Explorer <ExternalLink size={12} />
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return <div className="py-8 text-center text-sm" style={{ color: 'var(--muted)' }}>{message}</div>
}
