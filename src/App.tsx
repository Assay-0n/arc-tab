import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { OpenTab } from './components/OpenTab'
import { PayPerCall } from './components/PayPerCall'
import { Settle } from './components/Settle'
import { TabEvents } from './components/TabEvents'
import { NetworkBanner } from './components/NetworkBanner'

const TABS = [
  { id: 'open', label: 'Open a tab' },
  { id: 'pay', label: 'Pay per call' },
  { id: 'settle', label: 'Settle' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('open')

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      {/* Header */}
      <header className="sticky top-0 z-10 px-4 py-3 flex items-center justify-between"
              style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
        <div>
          <span className="display text-lg font-semibold" style={{ color: 'var(--ink)' }}>
            Tab
          </span>
          <span className="text-xs ml-2" style={{ color: 'var(--subtle)' }}>USDC payment channels</span>
        </div>
        <div className="flex items-center gap-3">
          <NetworkBanner />
          <ConnectKitButton />
        </div>
      </header>

      <main className="px-4 py-6 max-w-lg mx-auto space-y-6">
        {/* Hero */}
        <div className="text-center space-y-1 pt-2">
          <h1 className="display text-2xl font-semibold" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
            Open once. Pay per call.
          </h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Lock USDC in one transaction. Sign vouchers off-chain. Settle anytime.
          </p>
        </div>

        {/* Card with tabs */}
        <div className="rounded-2xl overflow-hidden"
             style={{
               background: 'var(--surface-strong)',
               border: '1px solid var(--border)',
               boxShadow: '0 2px 24px rgba(18,45,69,0.06)',
             }}>

          {/* Tab nav */}
          <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex-1 py-3 text-sm font-medium transition-colors relative"
                style={{
                  color: activeTab === tab.id ? 'var(--accent)' : 'var(--muted)',
                  background: 'transparent',
                  borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: '-1px',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-5">
            {activeTab === 'open' && <OpenTab />}
            {activeTab === 'pay' && <PayPerCall />}
            {activeTab === 'settle' && <Settle />}
          </div>
        </div>

        {/* Events */}
        <div className="rounded-2xl p-5"
             style={{
               background: 'var(--surface-strong)',
               border: '1px solid var(--border)',
               boxShadow: '0 2px 24px rgba(18,45,69,0.04)',
             }}>
          <TabEvents />
        </div>

        {/* Footer */}
        <p className="text-center text-xs pb-4" style={{ color: 'var(--subtle)' }}>
          Built on Arc · USDC payment channels ·{' '}
          <a
            href="https://explorer.testnet.arc.io/address/0x327a5100afda9e7856fb715bc12dd63f942479c0"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent-hover)' }}
          >
            testnet contract
          </a>
          {' '}·{' '}
          <a
            href="https://explorer.arc.io/address/0x4b655638f6a0f413c83a61588d61063d944b14cf"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent-hover)' }}
          >
            mainnet contract
          </a>
        </p>
      </main>
    </div>
  )
}
