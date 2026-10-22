/**
 * Tab contract configuration — deployed on both Arc Testnet and Arc Mainnet.
 */
import tabArtifact from '../contracts/out/Tab.sol/Tab.json'
import { getUsdc, requireChain } from '@/onchain-facts'

export const ARC_TESTNET_CHAIN_ID = 5042002
export const ARC_MAINNET_CHAIN_ID = 5042

export interface TabNetworkConfig {
  chainId: number
  chainName: string
  tabAddress: `0x${string}` | ''
  usdcAddress: `0x${string}`
  explorerBase: string
  /** Block at which the Tab contract was deployed — use as fromBlock for getLogs. */
  deployBlock: bigint
}

const arcTestnetChain = requireChain(ARC_TESTNET_CHAIN_ID)
const arcMainnetChain = requireChain(ARC_MAINNET_CHAIN_ID)

const testnetUsdc = getUsdc(ARC_TESTNET_CHAIN_ID)!
const mainnetUsdc = getUsdc(ARC_MAINNET_CHAIN_ID)!

export const NETWORKS: Record<number, TabNetworkConfig> = {
  [ARC_TESTNET_CHAIN_ID]: {
    chainId: ARC_TESTNET_CHAIN_ID,
    chainName: arcTestnetChain.name,
    tabAddress: '0x327a5100afda9e7856fb715bc12dd63f942479c0',
    usdcAddress: testnetUsdc.address as `0x${string}`,
    explorerBase: 'https://explorer.testnet.arc.io',
    deployBlock: 68505416n, // block of deploy tx 0x6dd5ac20… on Arc Testnet
  },
  [ARC_MAINNET_CHAIN_ID]: {
    chainId: ARC_MAINNET_CHAIN_ID,
    chainName: arcMainnetChain.name,
    tabAddress: '0x4b655638f6a0f413c83a61588d61063d944b14cf',
    usdcAddress: mainnetUsdc.address as `0x${string}`,
    explorerBase: 'https://explorer.arc.io',
    deployBlock: 27269303n, // block of deploy tx 0x208408da…
  },
}

export const TAB_ABI = tabArtifact.abi

/** EIP-712 domain for a given network config */
export function tabDomain(cfg: TabNetworkConfig) {
  return {
    name: 'Tab' as const,
    version: '1' as const,
    chainId: BigInt(cfg.chainId),
    verifyingContract: cfg.tabAddress as `0x${string}`,
  }
}

export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'tabId', type: 'uint256' },
    { name: 'cumulative', type: 'uint128' },
  ],
} as const

export function buildExplorerTxUrl(explorerBase: string, hash: string) {
  return `${explorerBase}/tx/${hash}`
}

export function buildExplorerAddrUrl(explorerBase: string, addr: string) {
  return `${explorerBase}/address/${addr}`
}

export function formatAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
