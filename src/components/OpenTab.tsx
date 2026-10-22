import { useState } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { erc20Abi, parseUnits } from 'viem'
import { ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID, NETWORKS, TAB_ABI, buildExplorerTxUrl } from '@/tabContract'
import { ExternalLink } from 'lucide-react'

const EXPIRY_OPTIONS = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
]

export function OpenTab() {
  const { address, chainId, isConnected } = useAccount()

  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [expiryOption, setExpiryOption] = useState(0) // index into EXPIRY_OPTIONS
  const [lastTabId, setLastTabId] = useState<bigint | null>(null)

  const supported = chainId === ARC_TESTNET_CHAIN_ID || chainId === ARC_MAINNET_CHAIN_ID
  const net = supported ? NETWORKS[chainId] : null

  // USDC allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: net?.usdcAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && net?.tabAddress ? [address, net.tabAddress] : undefined,
    chainId: chainId as 5042002 | 5042,
    query: { enabled: !!address && !!net?.tabAddress },
  })

  const parsedAmount = (() => {
    try { return amount ? parseUnits(amount, 6) : 0n }
    catch { return 0n }
  })()

  const needsApproval = parsedAmount > 0n && (allowance ?? 0n) < parsedAmount

  // Approve
  const { writeContract: approve, data: approveTxHash, isPending: approveWaiting } = useWriteContract()
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash })

  // Open tab
  const { writeContract: openTab, data: openTxHash, isPending: openWaiting, reset: resetOpen } = useWriteContract()
  const { isLoading: openConfirming, isSuccess: openSuccess, data: openReceipt } = useWaitForTransactionReceipt({ hash: openTxHash })

  // After approval settles, refetch allowance
  if (approveSuccess && net) {
    void refetchAllowance()
  }

  // Parse tabId from TabOpened event
  const tabId = (() => {
    if (!openReceipt) return null
    // TabOpened(uint256 indexed tabId, ...)
    for (const log of openReceipt.logs) {
      if (log.topics.length >= 2) {
        try {
          const topic = log.topics[1]
          if (!topic) continue
          return BigInt(topic)
        } catch {
          // continue
        }
      }
    }
    return null
  })()

  if (openSuccess && tabId !== null && lastTabId !== tabId) {
    setLastTabId(tabId)
  }

  const isValid = payee.startsWith('0x') && payee.length === 42 && parsedAmount > 0n && !!net

  function handleApprove() {
    if (!net?.tabAddress) return
    approve({
      address: net.usdcAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [net.tabAddress, parsedAmount],
      chainId: chainId as 5042002 | 5042,
    })
  }

  function handleOpen() {
    if (!net?.tabAddress || !isValid) return
    const expiryTs = BigInt(Math.floor(Date.now() / 1000) + EXPIRY_OPTIONS[expiryOption].seconds)
    openTab({
      address: net.tabAddress,
      abi: TAB_ABI,
      functionName: 'open',
      args: [payee as `0x${string}`, parsedAmount, expiryTs],
      chainId: chainId as 5042002 | 5042,
    })
  }

  if (!isConnected) {
    return <EmptyState message="Connect your wallet to open a tab." />
  }

  if (!supported) {
    return <EmptyState message="Switch to Arc Testnet or Arc Mainnet to use Tab." />
  }

  if (!net!.tabAddress) {
    return <EmptyState message="Tab is not deployed on this network." />
  }

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        Lock USDC once. Sign vouchers off-chain per API call. The service redeems them whenever it likes.
      </p>

      <div className="space-y-3">
        {/* Payee */}
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>
            Service address (payee)
          </label>
          <input
            value={payee}
            onChange={e => setPayee(e.target.value)}
            placeholder="0x…"
            className="mono w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors"
            style={{
              background: 'var(--surface-muted)',
              border: '1px solid var(--border)',
              color: 'var(--ink)',
              fontFamily: 'inherit',
            }}
          />
        </div>

        {/* Amount */}
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>
            Deposit amount (USDC)
          </label>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="10.00"
            type="number"
            min="0"
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

        {/* Expiry */}
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>
            Tab expires in
          </label>
          <div className="flex gap-2">
            {EXPIRY_OPTIONS.map((opt, i) => (
              <button
                key={i}
                onClick={() => setExpiryOption(i)}
                className="flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
                style={{
                  background: expiryOption === i ? 'var(--accent)' : 'var(--surface-muted)',
                  color: expiryOption === i ? '#fff' : 'var(--ink)',
                  border: '1px solid var(--border)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-2 pt-1">
        {needsApproval && (
          <button
            onClick={handleApprove}
            disabled={!isValid || approveWaiting || approveConfirming}
            className="w-full rounded-xl py-3 font-semibold text-sm transition-colors"
            style={{
              background: approveWaiting || approveConfirming ? 'var(--surface-muted)' : 'var(--accent)',
              color: approveWaiting || approveConfirming ? 'var(--muted)' : '#fff',
            }}
          >
            {approveWaiting ? 'Confirm in wallet…' : approveConfirming ? 'Approving…' : 'Allow USDC'}
          </button>
        )}

        <button
          onClick={handleOpen}
          disabled={!isValid || needsApproval || openWaiting || openConfirming}
          className="w-full rounded-xl py-3 font-semibold text-sm transition-colors"
          style={{
            background: (!isValid || needsApproval || openWaiting || openConfirming)
              ? 'var(--surface-muted)'
              : 'var(--accent)',
            color: (!isValid || needsApproval || openWaiting || openConfirming)
              ? 'var(--muted)'
              : '#fff',
          }}
        >
          {openWaiting ? 'Confirm in wallet…' : openConfirming ? 'Opening tab…' : 'Open tab'}
        </button>
      </div>

      {/* Success */}
      {openSuccess && lastTabId !== null && openTxHash && (
        <div className="rounded-xl p-4 space-y-2" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold" style={{ color: 'var(--success)' }}>Tab opened</span>
            <a
              href={buildExplorerTxUrl(net!.explorerBase, openTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs"
              style={{ color: 'var(--accent-hover)' }}
            >
              Explorer <ExternalLink size={12} />
            </a>
          </div>
          <div className="mono text-xs" style={{ color: 'var(--muted)' }}>
            Tab ID: <span className="font-semibold" style={{ color: 'var(--ink)' }}>{lastTabId.toString()}</span>
          </div>
          <button
            onClick={() => { resetOpen(); setPayee(''); setAmount(''); setLastTabId(null); }}
            className="text-xs underline"
            style={{ color: 'var(--muted)' }}
          >
            Open another
          </button>
        </div>
      )}
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
      {message}
    </div>
  )
}
