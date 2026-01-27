# TYKORA

TYKORA is a prize-linked savings vault deployed on **Rootstock**. Users deposit **DOC (MoneyOnChain)** or **USDRIF (Rootstock)**, earn yield through an external strategy (designed for **Tropykus**), and participate in recurring prize draws where **three distinct winners** are selected using deterministic randomness anchored to **Bitcoin block headers** via the **Rootstock bridge**.

**Developed by JXLabs.**

---

## Key Features

- **Deposit DOC & USDRIF, earn yield:** deposits are deployed into a yield strategy.
- **Prize-linked savings:** yield is split into **prize / treasury / keeper**.
- **3 winners per draw:** prize split is **50% / 30% / 20%**.
- **BTC-anchored randomness:** seed is derived from a BTC block header hash (Rootstock bridge).
- **Non-transferable shares:** shares represent deposit position (mint/burn only).
- **Vault locking during settlement:** withdrawals are disabled while a draw is locked (close → award → claim).
- **Bilingual UI:** English (default) + Spanish.

---

## Architecture Overview

### On-chain
- **PrizeVault (Vault Contract)**
  - Accepts deposits/withdrawals (when unlocked)
  - Tracks principal and yield
  - Manages draw lifecycle: `OPEN → CLOSED → AWARDED → CLAIMED`
  - Selects winners weighted by shares (tickets)
  - Distributes prize + fees
- **Strategy (IStrategy)**
  - Receives DOC or USDRIF from the vault and deploys into an external venue (designed for Tropykus)
  - Exposes: `deposit`, `withdrawUnderlying`, `totalUnderlying`, `accrue`
- **Rootstock Bridge**
  - Used to fetch BTC block headers by height to derive an objective seed

### Off-chain
- **Frontend (React + wagmi + RainbowKit + viem)**
  - Deposit/withdraw/claim flows
  - Draw status, prize/yield display
  - Previous winners list with explorer links
  - Keeper panel (close/award/claim)

---

## Vault Lifecycle (High-level)

1. **OPEN:** deposits enabled; yield accrues.
2. **CLOSE:** `closeDraw()` snapshots yield/fees/prize and sets a future BTC target height.
3. **LOCKED:** withdrawals disabled while the draw is being awarded/claimed.
4. **AWARD:** `awardDrawFromBtc(drawId)` fetches BTC header → derives seed → selects winners.
5. **CLAIM:** `claimDraw(drawId)` pays keeper tip + treasury + winners; unlocks vault; starts next draw.

> If there is **no yield** or **no participants** (`tickets == 0`) at close time, the draw is auto-finalized and the next draw begins immediately (no lock, no award/claim).

---

## Randomness & Winner Selection (Deterministic)

At draw close:
- `btcTargetHeight = bestBtcHeight + btcConfirmations` is stored.

To award a draw from BTC:
1. Fetch BTC block header at `btcTargetHeight` from the Rootstock bridge.
2. Compute:
   - `btcHash = doubleSha256(header)`
   - `seed = keccak256(btcHash, vaultAddress, drawId)`
3. Use the seed to select **three distinct winners** weighted by deposit shares (“tickets”).

Winner selection is **verifiable** by anyone using on-chain state and bridge data.

---

## Prize Distribution

- Yield is computed as: `max(totalAssets - totalPrincipal, 0)`
- Fees:
  - `treasuryFee = yield * treasuryBps / 10,000`
  - `keeperTip = yield * keeperBps / 10,000`
- Prize:
  - `prize = yield - treasuryFee - keeperTip`
- Winners:
  - Winner #1: 50%
  - Winner #2: 30%
  - Winner #3: 20%
  - Any integer division remainder is assigned to Winner #1.

---

## Trademark Notice
The code is licensed under MIT. The TYKORA and JXLabs names and logos are not granted under this license.
See `TRADEMARKS.md`.