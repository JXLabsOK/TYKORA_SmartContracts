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

### Modulo Reduction Note
## TYKO-09  -  2026 04 21
Winner selection uses a deterministic pseudo-random value derived from `keccak256(...)` and reduced to the active ticket range.

As with any modulo-based reduction, this introduces a theoretical bias whenever the random domain size is not an exact multiple of the ticket range. In practice, because the source value is 256 bits wide, the bias is negligible and has no meaningful impact on fairness or exploitability for realistic ticket counts.

This behavior is acknowledged and accepted as part of the current design.

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
## TYKO-04  -  2026 04 21
## Dependency on Tropykus Liquidity and Exchange Rate

Tykora depends on the Tropykus lending market to source yield and to redeem underlying assets when settling draws and processing withdrawals.

### Draw settlement dependency
When a draw is closed, the vault may need to redeem underlying from the strategy in order to reserve the prize, treasury fee, and keeper tip. If Tropykus liquidity is temporarily insufficient, draw settlement may revert and remain pending until liquidity becomes available again.

### Withdrawal dependency
User withdrawals also depend on the amount of underlying liquidity that can be redeemed from Tropykus at that moment. During periods of high utilization, withdrawals may be delayed or unavailable depending on idle liquidity and redeemable funds.

### High utilization risk
In high-utilization conditions, Tropykus may not have enough available cash to satisfy redemptions immediately. In that case:
- `closeDraw()` may revert and the draw may remain open until liquidity recovers.
- Withdrawals that require redeeming funds from the lending market may also revert until liquidity improves.

This condition is generally expected to be temporary in money-market systems, since elevated borrow rates tend to incentivize repayments and restore liquidity over time.

### Bad debt / exchange rate risk
If bad debt is socialized at the lending-market level and the kToken exchange rate decreases, Tykora’s total assets may fall relative to total principal. In that situation:
- A draw may finalize with zero distributable yield.
- Withdrawals may eventually fail once the remaining redeemable balance is exhausted.

Unlike short-term utilization spikes, a bad debt event may not self-correct, because the loss is already realized in the exchange rate.

### User and integrator note
Tykora does not guarantee instant liquidity independently of Tropykus. Draw settlement and withdrawals are economically and technically dependent on:
- Tropykus pool liquidity
- the redeemability of underlying assets
- the kToken exchange rate

Users and integrators should treat Tropykus market conditions as an external dependency of the protocol.

### Future consideration
A future version of Tykora may evaluate a mechanism to account for and socialize lending-market bad debt across depositors at the protocol level.

## TYKO-06  -  2026 04 21
## Yield Roll-Over When No Depositors Remain

Tykora calculates distributable yield at draw close as the difference between `totalAssets()` and `totalPrincipal`.

If all depositors withdraw from the vault:

- `totalPrincipal` becomes `0`
- `totalTickets()` becomes `0`
- any undistributed yield still held in the strategy is not immediately distributed

In that situation, `closeDraw()` auto-finalizes the draw because there are no active tickets, and the remaining yield stays in the strategy.

As a result, if a new depositor joins the vault later, that depositor may participate in a future draw whose prize includes yield generated before they entered the vault.

This behavior is part of Tykora’s yield roll-over model and only occurs when all prior depositors have fully exited the vault.
---
## Trademark Notice
The code is licensed under MIT. The TYKORA and JXLabs names and logos are not granted under this license.
See `TRADEMARKS.md`.