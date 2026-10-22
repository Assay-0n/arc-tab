import { useAccount, useSwitchChain } from 'wagmi'
import { ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID, NETWORKS } from '@/tabContract'

export function NetworkBanner() {
  const { chainId, isConnected } = useAccount()
  const { switchChain, isPending } = useSwitchChain()

  if (!isConnected) return null

  const supported = chainId === ARC_TESTNET_CHAIN_ID || chainId === ARC_MAINNET_CHAIN_ID

  if (supported) {
    const net = NETWORKS[chainId]
    const isTestnet = chainId === ARC_TESTNET_CHAIN_ID
    const otherChainId = isTestnet ? ARC_MAINNET_CHAIN_ID : ARC_TESTNET_CHAIN_ID
    const otherLabel = isTestnet ? 'Mainnet' : 'Testnet'
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
             style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
          {net.chainName}
        </div>
        <button
          onClick={() => switchChain({ chainId: otherChainId })}
          disabled={isPending}
          className="px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{
            background: 'var(--surface-muted)',
            border: '1px solid var(--border)',
            color: 'var(--accent-hover)',
          }}
        >
          {isPending ? '…' : `Switch to ${otherLabel}`}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium"
         style={{ background: '#fff3cd', color: '#7a5c00', border: '1px solid #ffd966' }}>
      Wrong network. Switch to:
      <button
        onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })}
        disabled={isPending}
        className="underline font-semibold"
        style={{ color: '#1061a6' }}
      >
        Arc Testnet
      </button>
      {' '}or{' '}
      <button
        onClick={() => switchChain({ chainId: ARC_MAINNET_CHAIN_ID })}
        disabled={isPending}
        className="underline font-semibold"
        style={{ color: '#1061a6' }}
      >
        Arc Mainnet
      </button>
    </div>
  )
}
