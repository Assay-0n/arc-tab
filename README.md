# Tab — USDC Payment Channels

Tab is a one-way USDC payment channel contract on Arc. A client locks USDC once, then pays a service per call by signing EIP-712 vouchers off-chain. The service redeems them in a single on-chain transaction whenever it likes. One `open` covers hundreds of calls with no per-call gas.

## The flow

1. Client calls `open(payee, amount, expiry)` — locks USDC in the contract and gets a `tabId`.
2. For each API call, the client signs an EIP-712 `Voucher{tabId, cumulative}` off-chain (no transaction, instant).
3. The service verifies the signature locally against the payer's address read from `tabs[tabId].payer`.
4. When the service wants to collect, it calls `settle` or `settleAndClose` with the latest voucher — one transaction pays all calls since the last settlement.
5. After the tab expires, the payer reclaims any unspent deposit with `reclaim`.

## Contract API

```
open(address payee, uint128 amount, uint64 expiry) → uint256 tabId
  Transfer USDC from msg.sender into the contract. Returns the new tabId.

topUp(uint256 tabId, uint128 amount)
  Add more USDC to an open tab. Payer only. Tab must not be expired or closed.

extend(uint256 tabId, uint64 newExpiry)
  Push the expiry forward. Payer only. newExpiry must exceed current expiry.

settle(uint256 tabId, uint128 cumulative, bytes signature)
  Submit a voucher. Pays (cumulative - settled) USDC to the payee. Anyone can call.
  Reverts if the tab is closed or expired.

settleAndClose(uint256 tabId, uint128 cumulative, bytes signature)
  Payee only. Pays the delta to the payee, refunds (deposit - cumulative) to the payer,
  marks the tab closed. Works any time until the tab is closed — no expiry restriction.

reclaim(uint256 tabId)
  Payer only. After expiry, refunds (deposit - settled) to the payer and marks closed.

voucherDigest(uint256 tabId, uint128 cumulative) → bytes32
  Returns the EIP-712 digest a client should sign.

remaining(uint256 tabId) → uint128
  Returns deposit - settled.

tabs(uint256 tabId) → (address payer, address payee, uint128 deposit, uint128 settled, uint64 expiry, bool closed)
  Read the full state of a tab.
```

## How a service verifies a voucher off-chain

The service should check signatures before serving requests, so it never serves a call it cannot settle on-chain.

```typescript
import { verifyTypedData } from 'viem'

// Arc Testnet
const domain = {
  name: 'Tab',
  version: '1',
  chainId: 5042002n,
  verifyingContract: '0x327a5100afda9e7856fb715bc12dd63f942479c0' as `0x${string}`,
} as const

// Arc Mainnet — use chainId 5042n and the mainnet address
// const domain = {
//   name: 'Tab', version: '1',
//   chainId: 5042n,
//   verifyingContract: '0x4b655638f6a0f413c83a61588d61063d944b14cf' as `0x${string}`,
// } as const

const VOUCHER_TYPES = {
  Voucher: [
    { name: 'tabId',      type: 'uint256' },
    { name: 'cumulative', type: 'uint128' },
  ],
} as const

async function checkVoucher(
  payer: `0x${string}`,
  tabId: bigint,
  cumulative: bigint,
  lastAccepted: bigint,
  deposit: bigint,
  signature: `0x${string}`,
): Promise<{ ok: boolean; reason?: string }> {
  if (cumulative <= lastAccepted) return { ok: false, reason: 'stale voucher' }
  if (cumulative > deposit)       return { ok: false, reason: 'exceeds deposit' }
  const valid = await verifyTypedData({
    address: payer,
    domain,
    types: VOUCHER_TYPES,
    primaryType: 'Voucher',
    message: { tabId, cumulative },
    signature,
  })
  return valid ? { ok: true } : { ok: false, reason: 'bad signature' }
}
```

Read `tabs[tabId]` once per session (or cache with a short TTL) to get `payer`, `deposit`, and `settled`.

## Deployed contracts

| Network | Address | Explorer |
|---|---|---|
| Arc Testnet | `0x327a5100afda9e7856fb715bc12dd63f942479c0` | [view](https://explorer.testnet.arc.io/address/0x327a5100afda9e7856fb715bc12dd63f942479c0) |
| Arc Mainnet | `0x4b655638f6a0f413c83a61588d61063d944b14cf` | [view](https://explorer.arc.io/address/0x4b655638f6a0f413c83a61588d61063d944b14cf) |

USDC address on Arc (both networks): `0x3600000000000000000000000000000000000000`

## Live on Arc mainnet

The contract is deployed at [`0x4b655638f6a0f413c83a61588d61063d944b14cf`](https://explorer.arc.io/address/0x4b655638f6a0f413c83a61588d61063d944b14cf) on Arc mainnet. The first tab ran 25 calls at 0.001 USDC each, settled twice, and refunded the remaining deposit; all its transactions are on the contract's explorer page.

The testnet contract is at [`0x327a5100afda9e7856fb715bc12dd63f942479c0`](https://explorer.testnet.arc.io/address/0x327a5100afda9e7856fb715bc12dd63f942479c0) on Arc Testnet.

## Run it locally

```bash
bun install
bun run dev
```

Open http://localhost:5173. Connect a wallet on Arc Testnet, click "Get test USDC" in the Arc Studio sidebar to fund it, then open a tab.

## Build

```bash
bun run build
```

Output goes to `dist/`. The build uses relative asset paths (`base: './'`), so the contents of `dist/` can be served from any static host or sub-path without extra config.

## Deploying

```bash
# Arc Testnet
forge script contracts/script/DeployTab.s.sol \
  --rpc-url https://rpc.testnet.arc.io \
  --broadcast \
  --sig "run(address)" \
  0x3600000000000000000000000000000000000000

# Arc Mainnet
forge script contracts/script/DeployTab.s.sol \
  --rpc-url https://rpc.mainnet.arc.io \
  --broadcast \
  --sig "run(address)" \
  0x3600000000000000000000000000000000000000
```

After deploying, update `NETWORKS[chainId].tabAddress` and `NETWORKS[chainId].deployBlock` in `src/tabContract.ts`.

## Security notes

**settle works only until expiry.** After the tab expires, `settle` reverts. The payee must redeem outstanding vouchers before expiry, or use `settleAndClose` which has no expiry restriction when called by the payee.

**settleAndClose is payee-only and works any time until the payer reclaims.** The payee can close the tab and collect at any point, regardless of expiry, as long as the payer has not already called `reclaim`.

**The payer must never sign a voucher above what it intends to pay.** A signed voucher is an irrevocable payment commitment up to that cumulative amount. Signing `cumulative > deposit` wastes the signature (the contract will reject it), but signing a higher amount than intended and then relying on expiry is not safe — the payee can settle up to `deposit` at any time before the payer reclaims.

**No admin keys.** The contract has no owner, no admin, no proxy, no upgradeability. There is no way to pause, drain, or modify it. Bytecode is final.

**Cumulative vouchers are monotonic and bound to a specific tab, chain, and contract.** The contract rejects any voucher with `cumulative <= settled`, so old vouchers cannot be replayed. The EIP-712 domain includes `chainId` and `verifyingContract`, so a voucher from testnet tab 0 cannot be used on mainnet tab 0 and vice versa.

**Reentrancy guard on every USDC-moving function.** Checks-effects-interactions ordering is strict throughout.
