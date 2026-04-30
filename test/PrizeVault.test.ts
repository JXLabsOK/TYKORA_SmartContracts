import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const OPEN = 0;
const CLOSED = 1;
const AWARDED = 2;
const CLAIMED = 3;

const DAY = 24n * 60n * 60n;
const TEST_DRAW_PERIOD = 7n * DAY; // 7 days
const TEST_MIN_HOLD = 5n * DAY; // 5 days
const TEST_CUTOFF_OFFSET = TEST_DRAW_PERIOD - TEST_MIN_HOLD; // 2 days
const TEST_TREASURY_BPS = 900;
const TEST_KEEPER_BPS = 100;
const TEST_BTC_CONFIRMATIONS = 6;
const TEST_EMERGENCY_DELAY = 12 * 60 * 60; // 12 hours

function bn(v: string) {
  return ethers.parseUnits(v, 18);
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((x) => x.toLowerCase())));
}

function expectedSplit503020(prize: bigint, winnersCount: number): bigint[] {
  const exp: bigint[] = [0n, 0n, 0n];
  if (winnersCount <= 0 || prize === 0n) return exp;

  if (winnersCount === 1) {
    exp[0] = prize;
    return exp;
  }

  if (winnersCount === 2) {
    const p1 = (prize * 5n) / 8n; // renormalized 50:30 => 5/8 and 3/8
    exp[0] = p1;
    exp[1] = prize - p1;
    return exp;
  }

  // 3 winners: 50/30/20 with remainder to 3rd via subtraction
  const p1 = (prize * 5000n) / 10_000n;
  const p2 = (prize * 3000n) / 10_000n;
  const p3 = prize - p1 - p2;

  exp[0] = p1;
  exp[1] = p2;
  exp[2] = p3;
  return exp;
}
//TYKO-01  -  2026 04 20
async function advanceToDrawEnd(vault: any) {
  const end = await vault.drawEndTimestamp();
  await time.increaseTo(end + 1n);
}

// I'm keeping this name to avoid breaking existing tests.
// With the new logic, you no longer need to wait for `+hold` to close the draw.
async function advanceToEndAndMature(vault: any) {
  await advanceToDrawEnd(vault);
}

async function advancePastCutoff(vault: any) {
  const drawId = await vault.currentDrawId();
  const d = await vault.draws(drawId);
  const cutoff = BigInt(d.startedAt) + TEST_CUTOFF_OFFSET;
  await time.increaseTo(cutoff + 1n);
}

async function advanceWellPastDrawEnd(vault: any, extraSeconds: bigint = 0n) {
  const end = await vault.drawEndTimestamp();
  await time.increaseTo(end + 1n + extraSeconds);
}
//TYKO-01  -  2026 04 20 END

describe("PrizeVault", function () {
  async function fixture() {
    const [owner, treasury, keeper, alice, bob, carol, other] =
      await ethers.getSigners();

    // --- Deploy underlying (MockERC20) ---
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const doc = await MockERC20.deploy("Mock DOC", "DOC", 18);
    await doc.waitForDeployment();

    // Mint balances
    await doc.mint(alice.address, bn("2000000"));
    await doc.mint(bob.address, bn("10000"));
    await doc.mint(carol.address, bn("10000"));
    await doc.mint(other.address, bn("10000"));

    // --- Deploy vault (strategy NOT set yet) ---
    const PrizeVault = await ethers.getContractFactory("PrizeVault");

    const vault = await PrizeVault.deploy(
      await doc.getAddress(),
      "TYKORA Share",
      "tDOC",
      owner.address,
      treasury.address,
      TEST_DRAW_PERIOD,
      TEST_MIN_HOLD,
      TEST_TREASURY_BPS,
      TEST_KEEPER_BPS,
      TEST_BTC_CONFIRMATIONS,
      TEST_EMERGENCY_DELAY,
      ethers.ZeroAddress // bridge=0 => manual award mode in tests
    );
    await vault.waitForDeployment();

    // --- Deploy strategy (MockStrategy) ---
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const strategy = await MockStrategy.deploy(
      await vault.getAddress(),
      await doc.getAddress()
    );
    await strategy.waitForDeployment();

    return {
      owner,
      treasury,
      keeper,
      alice,
      bob,
      carol,
      other,
      doc,
      strategy,
      vault,
      drawPeriod: TEST_DRAW_PERIOD,
      treasuryBps: TEST_TREASURY_BPS,
      keeperBps: TEST_KEEPER_BPS,
      emergencyDelay: TEST_EMERGENCY_DELAY,
      minHoldForEligibilitySeconds: TEST_MIN_HOLD,
    };
  }
  //TYKO-01  -  2026 04 20
  describe("TYKO-01 cooldown / JIT protection", function () {
    it("deposit before cutoff is eligible for current draw", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await advanceToDrawEnd(vault);
      await vault.connect(owner).closeDraw();

      expect(await vault.eligibleForDraw(alice.address, 1n)).to.eq(true);
    });

    it("deposit exactly at cutoff is eligible for current draw", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      const drawId = await vault.currentDrawId();
      const d = await vault.draws(drawId);
      const cutoff = BigInt(d.startedAt) + TEST_CUTOFF_OFFSET;

      // approve before
      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));

      // IMPORTANT: el bloque del deposit debe minarse exactamente en cutoff
      await time.setNextBlockTimestamp(cutoff);
      await vault.connect(alice).deposit(bn("100"));

      await advanceToDrawEnd(vault);
      await vault.connect(owner).closeDraw();

      expect(await vault.eligibleForDraw(alice.address, 1n)).to.eq(true);
    });

    it("deposit after cutoff is NOT eligible for current draw", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await advancePastCutoff(vault);

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await advanceToDrawEnd(vault);
      await vault.connect(owner).closeDraw();

      expect(await vault.eligibleForDraw(alice.address, 1n)).to.eq(false);
    });

    it("deposit after scheduled end but before closeDraw is NOT eligible", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await advanceWellPastDrawEnd(vault);

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await vault.connect(owner).closeDraw();

      expect(await vault.eligibleForDraw(alice.address, 1n)).to.eq(false);
    });

    it("late closeDraw does not make late deposit eligible", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await advanceWellPastDrawEnd(vault);

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await time.increase(3n * DAY);

      await vault.connect(owner).closeDraw();

      expect(await vault.eligibleForDraw(alice.address, 1n)).to.eq(false);
    });

    it("3 sybil addresses depositing after draw end cannot win any slot", async () => {
      const signers = await ethers.getSigners();
      const { vault, strategy, owner, keeper, alice, bob, carol, doc } =
        await loadFixture(fixture);

      const eve1 = signers[7];
      const eve2 = signers[8];
      const eve3 = signers[9];

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      const vaultAddr = await vault.getAddress();

      for (const u of [alice, bob, carol]) {
        await doc.connect(u).approve(vaultAddr, bn("1000"));
        await vault.connect(u).deposit(bn("1000"));
      }

      // Generate yield for the draw
      await doc.mint(await strategy.getAddress(), bn("300"));

      // Eve deposits AFTER scheduled draw end, BEFORE closeDraw()
      await advanceWellPastDrawEnd(vault);

      for (const e of [eve1, eve2, eve3]) {
        await doc.mint(e.address, bn("3000"));
        await doc.connect(e).approve(vaultAddr, bn("3000"));
        await vault.connect(e).deposit(bn("3000"));
      }

      await vault.connect(keeper).closeDraw();

      const seed = ethers.id("tyko-01-sybil-mitigated");
      await vault.connect(owner).awardDrawManual(1n, seed);

      const [wc, winnersFixed] = await vault.getWinners(1n);
      const winnersCount = Number(wc);
      const winnersArr = (winnersFixed as unknown as string[])
        .slice(0, winnersCount)
        .map((x) => x.toLowerCase());

      const eveSet = new Set([
        eve1.address.toLowerCase(),
        eve2.address.toLowerCase(),
        eve3.address.toLowerCase(),
      ]);

      expect(winnersArr.length).to.be.greaterThan(0);

      for (const w of winnersArr) {
        expect(eveSet.has(w)).to.eq(false, `sybil address ${w} should not be eligible`);
      }
    });

    it("re-enabling noTickets resets lastDepositAt and makes user wait for next draw", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await advancePastCutoff(vault);

      await vault.connect(owner).setNoTickets(alice.address, true);
      await vault.connect(owner).setNoTickets(alice.address, false);

      await advanceToDrawEnd(vault);
      await vault.connect(owner).closeDraw();

      expect(await vault.eligibleForDraw(alice.address, 1n)).to.eq(false);
    });
  });
  //TYKO-01  -  2026 04 20

  //TYKO-10  -  2026 04 30
  describe("TYKO-10 _pickWinnersDistinct remaining=0 handling", function () {
    it("does not revert when the only participant is ineligible; winnersCount=0", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // Alice deposits after cutoff => ineligible for current draw
      await advancePastCutoff(vault);

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      // add yield so draw actually locks and awards
      await doc.mint(await strategy.getAddress(), bn("10"));

      await advanceToDrawEnd(vault);
      await vault.connect(owner).closeDraw();

      const seed = ethers.id("tyko-10-single-ineligible");
      await expect(vault.connect(owner).awardDrawManual(1n, seed))
        .to.emit(vault, "DrawAwarded");

      const [wc, winnersFixed, prizes] = await vault.getWinners(1n);
      const winnersCount = Number(wc);

      expect(winnersCount).to.eq(0);
      expect(winnersFixed[0]).to.eq(ethers.ZeroAddress);
      expect(winnersFixed[1]).to.eq(ethers.ZeroAddress);
      expect(winnersFixed[2]).to.eq(ethers.ZeroAddress);
      expect(prizes[0]).to.eq(0n);
      expect(prizes[1]).to.eq(0n);
      expect(prizes[2]).to.eq(0n);
    });

    it("does not revert when all participants are ineligible; winnersCount=0", async () => {
      const { vault, strategy, owner, alice, bob, carol, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // Everyone deposits after cutoff => nobody is eligible
      await advancePastCutoff(vault);

      for (const u of [alice, bob, carol]) {
        await doc.connect(u).approve(await vault.getAddress(), bn("100"));
        await vault.connect(u).deposit(bn("100"));
      }

      await doc.mint(await strategy.getAddress(), bn("30"));

      await advanceToDrawEnd(vault);
      await vault.connect(owner).closeDraw();

      const seed = ethers.id("tyko-10-all-ineligible");
      await expect(vault.connect(owner).awardDrawManual(1n, seed))
        .to.emit(vault, "DrawAwarded");

      const [wc] = await vault.getWinners(1n);
      expect(Number(wc)).to.eq(0);
    });

    it("does not revert when fewer than 3 users are eligible; returns only eligible winners", async () => {
      const { vault, strategy, owner, alice, bob, carol, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // Alice deposits early => eligible
      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      // Bob and Carol deposit after cutoff => ineligible
      await advancePastCutoff(vault);

      await doc.connect(bob).approve(await vault.getAddress(), bn("100"));
      await vault.connect(bob).deposit(bn("100"));

      await doc.connect(carol).approve(await vault.getAddress(), bn("100"));
      await vault.connect(carol).deposit(bn("100"));

      await doc.mint(await strategy.getAddress(), bn("30"));

      await advanceToDrawEnd(vault);
      await vault.connect(owner).closeDraw();

      const seed = ethers.id("tyko-10-one-eligible");
      await expect(vault.connect(owner).awardDrawManual(1n, seed))
        .to.emit(vault, "DrawAwarded");

      const [wc, winnersFixed] = await vault.getWinners(1n);
      const winnersCount = Number(wc);
      const winners = (winnersFixed as unknown as string[])
        .slice(0, winnersCount)
        .map((w) => w.toLowerCase());

      expect(winnersCount).to.eq(1);
      expect(winners[0]).to.eq(alice.address.toLowerCase());
    });

    it("does not revert when minHoldForEligibility == drawPeriod and no one qualifies", async () => {
      const [owner, treasury, keeper, alice] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const doc = await MockERC20.deploy("Mock DOC", "DOC", 18);
      await doc.waitForDeployment();

      await doc.mint(alice.address, bn("1000"));

      const PrizeVault = await ethers.getContractFactory("PrizeVault");
      const vault = await PrizeVault.deploy(
        await doc.getAddress(),
        "TYKORA Share",
        "tDOC",
        owner.address,
        treasury.address,
        TEST_DRAW_PERIOD,
        TEST_DRAW_PERIOD, // minHold == drawPeriod
        TEST_TREASURY_BPS,
        TEST_KEEPER_BPS,
        TEST_BTC_CONFIRMATIONS,
        TEST_EMERGENCY_DELAY,
        ethers.ZeroAddress
      );
      await vault.waitForDeployment();

      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const strategy = await MockStrategy.deploy(
        await vault.getAddress(),
        await doc.getAddress()
      );
      await strategy.waitForDeployment();

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // Deposit after draw has already started => not eligible when hold == full draw period
      await time.increase(1n);

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await doc.mint(await strategy.getAddress(), bn("10"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await vault.connect(owner).closeDraw();

      const seed = ethers.id("tyko-10-hold-equals-draw");
      await expect(vault.connect(owner).awardDrawManual(1n, seed))
        .to.emit(vault, "DrawAwarded");

      const [wc] = await vault.getWinners(1n);
      expect(Number(wc)).to.eq(0);
    });
  });
  //TYKO-10  -  2026 04 30 END

  describe("constructor", function () {
    it("reverts on zero addresses / invalid params", async () => {
      const { owner, treasury, doc } = await loadFixture(fixture);
      const PrizeVault = await ethers.getContractFactory("PrizeVault");

      // underlying = 0 => custom error ZeroAddress()
      await expect(
        PrizeVault.deploy(
          ethers.ZeroAddress,
          "Share",
          "s",
          owner.address,
          treasury.address,
          TEST_DRAW_PERIOD,
          TEST_MIN_HOLD,
          TEST_TREASURY_BPS,
          TEST_KEEPER_BPS,
          TEST_BTC_CONFIRMATIONS,
          TEST_EMERGENCY_DELAY,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "ZeroAddress");

      // owner = 0 => OZ OwnableInvalidOwner(0x0)
      await expect(
        PrizeVault.deploy(
          await doc.getAddress(),
          "Share",
          "s",
          ethers.ZeroAddress,
          treasury.address,
          TEST_DRAW_PERIOD,
          TEST_MIN_HOLD,
          TEST_TREASURY_BPS,
          TEST_KEEPER_BPS,
          TEST_BTC_CONFIRMATIONS,
          TEST_EMERGENCY_DELAY,
          ethers.ZeroAddress
        )
      )
        .to.be.revertedWithCustomError(PrizeVault, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);

      // treasury = 0 => custom error ZeroAddress()
      await expect(
        PrizeVault.deploy(
          await doc.getAddress(),
          "Share",
          "s",
          owner.address,
          ethers.ZeroAddress,
          TEST_DRAW_PERIOD,
          TEST_MIN_HOLD,
          TEST_TREASURY_BPS,
          TEST_KEEPER_BPS,
          TEST_BTC_CONFIRMATIONS,
          TEST_EMERGENCY_DELAY,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "ZeroAddress");

      // drawPeriodSeconds == 0
      await expect(
        PrizeVault.deploy(
          await doc.getAddress(),
          "Share",
          "s",
          owner.address,
          treasury.address,
          0,
          1,
          TEST_TREASURY_BPS,
          TEST_KEEPER_BPS,
          TEST_BTC_CONFIRMATIONS,
          TEST_EMERGENCY_DELAY,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "InvalidBps");

      // treasuryBps + keeperBps > 10000
      await expect(
        PrizeVault.deploy(
          await doc.getAddress(),
          "Share",
          "s",
          owner.address,
          treasury.address,
          TEST_DRAW_PERIOD,
          TEST_MIN_HOLD,
          9000,
          2000,
          TEST_BTC_CONFIRMATIONS,
          TEST_EMERGENCY_DELAY,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "InvalidBps");

      // emergencyDelaySeconds == 0
      await expect(
        PrizeVault.deploy(
          await doc.getAddress(),
          "Share",
          "s",
          owner.address,
          treasury.address,
          TEST_DRAW_PERIOD,
          TEST_MIN_HOLD,
          TEST_TREASURY_BPS,
          TEST_KEEPER_BPS,
          TEST_BTC_CONFIRMATIONS,
          0,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "InvalidBps");
    });
    //TYKO-01  -  2026 04 20
    it("reverts if minHoldForEligibilitySeconds == 0", async () => {
      const { owner, treasury, doc } = await loadFixture(fixture);
      const PrizeVault = await ethers.getContractFactory("PrizeVault");

      await expect(
        PrizeVault.deploy(
          await doc.getAddress(),
          "Share",
          "s",
          owner.address,
          treasury.address,
          TEST_DRAW_PERIOD,
          0,
          TEST_TREASURY_BPS,
          TEST_KEEPER_BPS,
          TEST_BTC_CONFIRMATIONS,
          TEST_EMERGENCY_DELAY,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "InvalidMinHoldForEligibility");
    });

    it("reverts if minHoldForEligibilitySeconds > drawPeriod", async () => {
      const { owner, treasury, doc } = await loadFixture(fixture);
      const PrizeVault = await ethers.getContractFactory("PrizeVault");

      await expect(
        PrizeVault.deploy(
          await doc.getAddress(),
          "Share",
          "s",
          owner.address,
          treasury.address,
          TEST_DRAW_PERIOD,
          TEST_DRAW_PERIOD + 1n,
          TEST_TREASURY_BPS,
          TEST_KEEPER_BPS,
          TEST_BTC_CONFIRMATIONS,
          TEST_EMERGENCY_DELAY,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "InvalidMinHoldForEligibility");
    });
    //TYKO-01  -  2026 04 20 END

    it("initializes draw #1 as OPEN", async () => {
      const { vault } = await loadFixture(fixture);

      expect(await vault.currentDrawId()).to.eq(1n);

      const d = await vault.draws(1n);
      expect(Number(d.status)).to.eq(OPEN);
      expect(d.startedAt).to.not.eq(0n);

      expect(await vault.totalPrincipal()).to.eq(0n);
      expect(await vault.isLocked()).to.eq(false);
      expect(await vault.totalTickets()).to.eq(0n);
    });
  });

  describe("admin", function () {
    it("setStrategy: onlyOwner, only once, must match underlying", async () => {
      const { vault, strategy, other, owner, doc } = await loadFixture(fixture);

      await expect(vault.connect(other).setStrategy(await strategy.getAddress()))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(other.address);

      await expect(vault.connect(owner).setStrategy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");

      // underlying mismatch
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const otherToken = await MockERC20.deploy("Other", "OTH", 18);
      await otherToken.waitForDeployment();

      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const badStrategy = await MockStrategy.deploy(
        await vault.getAddress(),
        await otherToken.getAddress()
      );
      await badStrategy.waitForDeployment();

      await expect(vault.connect(owner).setStrategy(await badStrategy.getAddress()))
        .to.be.revertedWithCustomError(vault, "StrategyUnderlyingMismatch")
        .withArgs(await doc.getAddress(), await otherToken.getAddress());

      await expect(vault.connect(owner).setStrategy(await strategy.getAddress()))
        .to.emit(vault, "StrategySet")
        .withArgs(await strategy.getAddress());

      await expect(vault.connect(owner).setStrategy(await strategy.getAddress()))
        .to.be.revertedWithCustomError(vault, "StrategyAlreadySet");
    });

    it("setTreasury: onlyOwner, zero address blocked", async () => {
      const { vault, other, owner } = await loadFixture(fixture);

      await expect(vault.connect(other).setTreasury(other.address))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(other.address);

      await expect(vault.connect(owner).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");

      await expect(vault.connect(owner).setTreasury(other.address))
        .to.emit(vault, "TreasurySet")
        .withArgs(other.address);

      expect(await vault.treasury()).to.eq(other.address);
    });

    it("setStrategy: sets MAX allowance from vault to strategy (one-time approve)", async () => {
      const { vault, strategy, owner, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      const allowance = await doc.allowance(
        await vault.getAddress(),
        await strategy.getAddress()
      );
      expect(allowance).to.eq(ethers.MaxUint256);
    });
  });

  //TYKO-05  -  2026 04 21
  describe("TYKO-05 strategy token recovery", function () {
    it("recoverStrategyERC20: onlyOwner", async () => {
      const { vault, strategy, owner, other } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await expect(
        vault.connect(other).recoverStrategyERC20(
          ethers.ZeroAddress,
          other.address,
          1n
        )
      )
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
    });

    it("recoverStrategyERC20: reverts if strategy is not set", async () => {
      const { vault, owner, other } = await loadFixture(fixture);

      await expect(
        vault.connect(owner).recoverStrategyERC20(
          ethers.ZeroAddress,
          other.address,
          1n
        )
      ).to.be.revertedWithCustomError(vault, "StrategyNotSet");
    });

    it("recoverStrategyERC20: reverts on zero address and zero amount", async () => {
      const { vault, strategy, owner, other } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await expect(
        vault.connect(owner).recoverStrategyERC20(
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          1n
        )
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");

      await expect(
        vault.connect(owner).recoverStrategyERC20(
          ethers.ZeroAddress,
          other.address,
          0n
        )
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("recoverStrategyERC20: recovers arbitrary ERC20 accidentally sent to strategy", async () => {
      const [owner, treasury, keeper, alice, bob, carol, other] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const doc = await MockERC20.deploy("Mock DOC", "DOC", 18);
      await doc.waitForDeployment();

      const PrizeVault = await ethers.getContractFactory("PrizeVault");
      const vault = await PrizeVault.deploy(
        await doc.getAddress(),
        "TYKORA Share",
        "tDOC",
        owner.address,
        treasury.address,
        TEST_DRAW_PERIOD,
        TEST_MIN_HOLD,
        TEST_TREASURY_BPS,
        TEST_KEEPER_BPS,
        TEST_BTC_CONFIRMATIONS,
        TEST_EMERGENCY_DELAY,
        ethers.ZeroAddress
      );
      await vault.waitForDeployment();

      const MockKToken = await ethers.getContractFactory("MockKToken");
      const kToken = await MockKToken.deploy(
        await doc.getAddress(),
        "kDOC",
        "kDOC",
        18,
        ethers.parseUnits("1", 18)
      );
      await kToken.waitForDeployment();

      const TropykusDoCStrategy = await ethers.getContractFactory("TropykusDoCStrategy");
      const realStrategy = await TropykusDoCStrategy.deploy(
        await vault.getAddress(),
        await doc.getAddress(),
        await kToken.getAddress()
      );
      await realStrategy.waitForDeployment();

      await vault.connect(owner).setStrategy(await realStrategy.getAddress());

      const stray = await MockERC20.deploy("Stray", "STRAY", 18);
      await stray.waitForDeployment();

      await stray.mint(other.address, bn("500"));
      await stray.connect(other).transfer(await realStrategy.getAddress(), bn("50"));

      expect(await stray.balanceOf(await realStrategy.getAddress())).to.eq(bn("50"));
      expect(await stray.balanceOf(other.address)).to.eq(bn("450"));

      await expect(
        vault.connect(owner).recoverStrategyERC20(
          await stray.getAddress(),
          other.address,
          bn("50")
        )
      )
        .to.emit(realStrategy, "Recovered")
        .withArgs(await stray.getAddress(), bn("50"), other.address);

      expect(await stray.balanceOf(await realStrategy.getAddress())).to.eq(0n);
      expect(await stray.balanceOf(other.address)).to.eq(bn("500"));
    });

    it("recoverStrategyERC20: reverts for underlying and kToken", async () => {
      const [owner, treasury, keeper, alice, bob, carol, other] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const doc = await MockERC20.deploy("Mock DOC", "DOC", 18);
      await doc.waitForDeployment();

      const PrizeVault = await ethers.getContractFactory("PrizeVault");
      const vault = await PrizeVault.deploy(
        await doc.getAddress(),
        "TYKORA Share",
        "tDOC",
        owner.address,
        treasury.address,
        TEST_DRAW_PERIOD,
        TEST_MIN_HOLD,
        TEST_TREASURY_BPS,
        TEST_KEEPER_BPS,
        TEST_BTC_CONFIRMATIONS,
        TEST_EMERGENCY_DELAY,
        ethers.ZeroAddress
      );
      await vault.waitForDeployment();

      const MockKToken = await ethers.getContractFactory("MockKToken");
      const kToken = await MockKToken.deploy(
        await doc.getAddress(),
        "kDOC",
        "kDOC",
        18,
        ethers.parseUnits("1", 18)
      );
      await kToken.waitForDeployment();

      const TropykusDoCStrategy = await ethers.getContractFactory("TropykusDoCStrategy");
      const realStrategy = await TropykusDoCStrategy.deploy(
        await vault.getAddress(),
        await doc.getAddress(),
        await kToken.getAddress()
      );
      await realStrategy.waitForDeployment();

      await vault.connect(owner).setStrategy(await realStrategy.getAddress());

      // underlying must be blocked
      await expect(
        vault.connect(owner).recoverStrategyERC20(
          await doc.getAddress(),
          other.address,
          bn("1")
        )
      ).to.be.revertedWithCustomError(realStrategy, "RecoverNotAllowed");

      // kToken must also be blocked
      await expect(
        vault.connect(owner).recoverStrategyERC20(
          await kToken.getAddress(),
          other.address,
          bn("1")
        )
      ).to.be.revertedWithCustomError(realStrategy, "RecoverNotAllowed");
    });
  });
  //TYKO-05  -  2026 04 21 END

  describe("deposits/withdrawals + non-transferable shares", function () {
    it("deposit: reverts if StrategyNotSet / ZeroAmount / VaultLocked", async () => {
      const { vault, alice, doc, strategy, owner } = await loadFixture(fixture);

      await expect(vault.connect(alice).deposit(bn("1")))
        .to.be.revertedWithCustomError(vault, "StrategyNotSet");

      await expect(vault.connect(alice).deposit(0n))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // Lock the vault by creating yield and closing draw
      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      // create yield (must be > 0 so it actually locks)
      await doc.mint(await strategy.getAddress(), bn("10"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await vault.connect(owner).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      await doc.connect(alice).approve(await vault.getAddress(), bn("1"));
      await expect(vault.connect(alice).deposit(bn("1")))
        .to.be.revertedWithCustomError(vault, "VaultLocked");
    });

    it("deposit mints shares 1:1, updates totalTickets, and shares are non-transferable", async () => {
      const { vault, strategy, owner, alice, bob, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("1000"));

      await expect(vault.connect(alice).deposit(bn("1000")))
        .to.emit(vault, "Deposited")
        .withArgs(alice.address, bn("1000"));

      expect(await vault.totalPrincipal()).to.eq(bn("1000"));
      expect(await vault.balanceOf(alice.address)).to.eq(bn("1000"));
      expect(await vault.totalTickets()).to.eq(bn("1000"));

      await expect(vault.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWith("NON_TRANSFERABLE");
    });

    it("tickets accounting: totalTickets tracks totalPrincipal across deposits/withdrawals", async () => {
      const { vault, strategy, owner, alice, bob, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await doc.connect(bob).approve(await vault.getAddress(), bn("250"));

      await vault.connect(alice).deposit(bn("100"));
      expect(await vault.totalPrincipal()).to.eq(bn("100"));
      expect(await vault.totalTickets()).to.eq(bn("100"));

      await vault.connect(bob).deposit(bn("250"));
      expect(await vault.totalPrincipal()).to.eq(bn("350"));
      expect(await vault.totalTickets()).to.eq(bn("350"));

      await vault.connect(alice).withdraw(bn("40"));
      expect(await vault.totalPrincipal()).to.eq(bn("310"));
      expect(await vault.totalTickets()).to.eq(bn("310"));

      await vault.connect(bob).withdrawAll();
      expect(await vault.totalPrincipal()).to.eq(bn("60"));
      expect(await vault.totalTickets()).to.eq(bn("60"));

      await vault.connect(alice).withdrawAll();
      expect(await vault.totalPrincipal()).to.eq(0n);
      expect(await vault.totalTickets()).to.eq(0n);
    });

    it("withdraw burns shares 1:1 and transfers underlying from strategy to user", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("1000"));
      await vault.connect(alice).deposit(bn("1000"));

      const pre = await doc.balanceOf(alice.address);

      await expect(vault.connect(alice).withdraw(bn("400")))
        .to.emit(vault, "Withdrawn")
        .withArgs(alice.address, bn("400"));

      expect(await vault.balanceOf(alice.address)).to.eq(bn("600"));
      expect(await vault.totalPrincipal()).to.eq(bn("600"));
      expect(await vault.totalTickets()).to.eq(bn("600"));

      const post = await doc.balanceOf(alice.address);
      expect(post - pre).to.eq(bn("400"));
    });

    it("withdrawAll withdraws full balance", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("250"));
      await vault.connect(alice).deposit(bn("250"));

      await vault.connect(alice).withdrawAll();

      expect(await vault.balanceOf(alice.address)).to.eq(0n);
      expect(await vault.totalPrincipal()).to.eq(0n);
      expect(await vault.totalTickets()).to.eq(0n);
    });

    it("deposit: does not decrease allowance when allowance is MaxUint256 (no per-deposit approve)", async () => {
      const { vault, strategy, owner, alice, bob, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      const vaultAddr = await vault.getAddress();
      const stratAddr = await strategy.getAddress();

      expect(await doc.allowance(vaultAddr, stratAddr)).to.eq(ethers.MaxUint256);

      await doc.connect(alice).approve(vaultAddr, bn("100"));
      await vault.connect(alice).deposit(bn("100"));
      expect(await doc.allowance(vaultAddr, stratAddr)).to.eq(ethers.MaxUint256);

      await doc.connect(bob).approve(vaultAddr, bn("50"));
      await vault.connect(bob).deposit(bn("50"));
      expect(await doc.allowance(vaultAddr, stratAddr)).to.eq(ethers.MaxUint256);
    });
  });

  describe("draw lifecycle: close -> award(manual) -> claim", function () {
    it("closeDraw: reverts if not ended", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());
      await doc.connect(alice).approve(await vault.getAddress(), bn("10"));
      await vault.connect(alice).deposit(bn("10"));

      const end = await vault.drawEndTimestamp();
      const now = await time.latest();
      expect(BigInt(now)).to.be.lessThan(end);

      await expect(vault.connect(owner).closeDraw())
        .to.be.revertedWithCustomError(vault, "DrawNotEnded");
    });

    it("closeDraw: if yield == 0 => auto-CLAIMED and starts next draw (no lock)", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());
      await doc.connect(alice).approve(await vault.getAddress(), bn("10"));
      await vault.connect(alice).deposit(bn("10"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await expect(vault.connect(owner).closeDraw()).to.emit(vault, "DrawClosed");

      const d1 = await vault.draws(1n);
      expect(Number(d1.status)).to.eq(CLAIMED);
      expect(d1.totalYield).to.eq(0n);
      expect(d1.prize).to.eq(0n);
      expect(d1.treasuryFee).to.eq(0n);
      expect(d1.keeperTip).to.eq(0n);
      expect(await vault.isLocked()).to.eq(false);

      expect(await vault.currentDrawId()).to.eq(2n);
      const d2 = await vault.draws(2n);
      expect(Number(d2.status)).to.eq(OPEN);
    });

    it("closeDraw: if tickets == 0 (even with yield > 0) => auto-CLAIMED, no lock, yield stays in strategy", async () => {
      const { vault, strategy, owner, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.mint(await strategy.getAddress(), bn("50"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await expect(vault.connect(owner).closeDraw()).to.emit(vault, "DrawClosed");

      const d1 = await vault.draws(1n);
      expect(Number(d1.status)).to.eq(CLAIMED);
      expect(d1.tickets).to.eq(0n);
      expect(d1.totalYield).to.eq(bn("50"));
      expect(d1.prize).to.eq(0n);
      expect(d1.treasuryFee).to.eq(0n);
      expect(d1.keeperTip).to.eq(0n);

      expect(await vault.isLocked()).to.eq(false);
      expect(await vault.currentDrawId()).to.eq(2n);

      expect(await doc.balanceOf(await vault.getAddress())).to.eq(0n);
      expect(await doc.balanceOf(await strategy.getAddress())).to.eq(bn("50"));
    });

    it("full happy-path: close (locks + reserves yield) -> manual award -> claim (pays + unlocks + new draw)", async () => {
      const { vault, strategy, owner, treasury, keeper, alice, bob, carol, doc } =
        await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await doc.connect(bob).approve(await vault.getAddress(), bn("200"));
      await doc.connect(carol).approve(await vault.getAddress(), bn("300"));

      await vault.connect(alice).deposit(bn("100"));
      await vault.connect(bob).deposit(bn("200"));
      await vault.connect(carol).deposit(bn("300"));

      expect(await vault.totalPrincipal()).to.eq(bn("600"));

      const ticketsSnap = await vault.totalTickets();
      expect(ticketsSnap).to.eq(bn("600"));

      // create yield: +1000 DOC on strategy
      await doc.mint(await strategy.getAddress(), bn("1000"));

      await advanceToEndAndMature(vault);

      const y = bn("1000");
      const treasFee = (y * 900n) / 10_000n; // 90
      const keepTip = (y * 100n) / 10_000n; // 10
      const prize = y - treasFee - keepTip; // 900

      await expect(vault.connect(keeper).closeDraw())
        .to.emit(vault, "DrawClosed")
        .withArgs(
          1n,
          anyValue,
          anyValue,
          0n,
          y,
          prize,
          treasFee,
          keepTip,
          ticketsSnap,
          keeper.address
        );

      expect(await vault.isLocked()).to.eq(true);

      const dClosed = await vault.draws(1n);
      expect(Number(dClosed.status)).to.eq(CLOSED);
      expect(dClosed.totalYield).to.eq(y);
      expect(dClosed.prize).to.eq(prize);
      expect(dClosed.tickets).to.eq(ticketsSnap);

      // payout reserved in vault (payout == y)
      expect(await doc.balanceOf(await vault.getAddress())).to.eq(y);

      // award manual by owner
      const seed = ethers.id("tykora-seed-1");

      await expect(vault.connect(owner).awardDrawManual(1n, seed))
        .to.emit(vault, "DrawAwarded")
        .withArgs(1n, seed, anyValue, anyValue, anyValue, anyValue, owner.address);

      const dAwarded = await vault.draws(1n);
      expect(Number(dAwarded.status)).to.eq(AWARDED);

      const [wc, winnersFixed, prizesFixed] = await vault.getWinners(1n);
      const winnersCount = Number(wc);
      const winnersArr = winnersFixed as unknown as [string, string, string];
      const prizesArr = prizesFixed as unknown as [bigint, bigint, bigint];

      expect(winnersCount).to.be.greaterThan(0);
      expect(winnersCount).to.be.lessThanOrEqual(3);

      const picked = winnersArr.slice(0, winnersCount);
      expect(uniq(picked).length).to.eq(winnersCount);

      const participants = [
        alice.address.toLowerCase(),
        bob.address.toLowerCase(),
        carol.address.toLowerCase(),
      ];
      for (const w of picked) {
        expect(participants).to.include(w.toLowerCase());
      }

      const expPrizes = expectedSplit503020(prize, winnersCount);
      expect(prizesArr[0]).to.eq(expPrizes[0]);
      expect(prizesArr[1]).to.eq(expPrizes[1]);
      expect(prizesArr[2]).to.eq(expPrizes[2]);
      expect(expPrizes[0] + expPrizes[1] + expPrizes[2]).to.eq(prize);

      const preTreas = await doc.balanceOf(treasury.address);
      const preKeeper = await doc.balanceOf(keeper.address);
      const preW = await Promise.all(picked.map((w) => doc.balanceOf(w)));

      await expect(vault.connect(keeper).claimDraw(1n))
        .to.emit(vault, "DrawClaimed")
        .withArgs(
          1n,
          winnersCount,
          anyValue,
          anyValue,
          anyValue,
          expPrizes[0],
          expPrizes[1],
          expPrizes[2],
          treasFee,
          keepTip,
          keeper.address
        );

      expect((await doc.balanceOf(treasury.address)) - preTreas).to.eq(treasFee);
      expect((await doc.balanceOf(keeper.address)) - preKeeper).to.eq(keepTip);

      const postW = await Promise.all(picked.map((w) => doc.balanceOf(w)));
      for (let i = 0; i < winnersCount; i++) {
        expect(postW[i] - preW[i]).to.eq(expPrizes[i]);
      }

      expect(await vault.isLocked()).to.eq(false);
      expect(await vault.currentDrawId()).to.eq(2n);

      const dClaimed = await vault.draws(1n);
      expect(Number(dClaimed.status)).to.eq(CLAIMED);

      const d2 = await vault.draws(2n);
      expect(Number(d2.status)).to.eq(OPEN);

      // payout fully distributed => vault idle should be 0
      expect(await doc.balanceOf(await vault.getAddress())).to.eq(0n);
    });

    it("award manual: works with 1 participant (winnersCount=1) and pays correctly", async () => {
      const { vault, strategy, owner, treasury, keeper, alice, doc } =
        await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await doc.mint(await strategy.getAddress(), bn("40"));

      await advanceToEndAndMature(vault);

      await vault.connect(owner).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      const y = bn("40");
      const treasFee = (y * 900n) / 10_000n;
      const keepTip = (y * 100n) / 10_000n;
      const prize = y - treasFee - keepTip;

      const seed = ethers.id("single-participant-seed");
      await vault.connect(owner).awardDrawManual(1n, seed);

      const [wc, winnersFixed, prizesFixed] = await vault.getWinners(1n);
      const winnersCount = Number(wc);
      const winnersArr = winnersFixed as unknown as [string, string, string];
      const prizesArr = prizesFixed as unknown as [bigint, bigint, bigint];

      expect(winnersCount).to.eq(1);
      expect(winnersArr[0].toLowerCase()).to.eq(alice.address.toLowerCase());

      const expPrizes = expectedSplit503020(prize, winnersCount);
      expect(prizesArr[0]).to.eq(expPrizes[0]);
      expect(expPrizes[0]).to.eq(prize);

      const preAlice = await doc.balanceOf(alice.address);
      const preTreas = await doc.balanceOf(treasury.address);
      const preKeeper = await doc.balanceOf(keeper.address);

      await vault.connect(keeper).claimDraw(1n);

      expect((await doc.balanceOf(treasury.address)) - preTreas).to.eq(treasFee);
      expect((await doc.balanceOf(keeper.address)) - preKeeper).to.eq(keepTip);
      expect((await doc.balanceOf(alice.address)) - preAlice).to.eq(prize);
    });

    it("index reuse safety: after bob withdraws all, bob must never be picked as winner", async () => {
      const { vault, strategy, owner, keeper, alice, bob, carol, other, doc } =
        await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await doc.connect(bob).approve(await vault.getAddress(), bn("200"));
      await doc.connect(carol).approve(await vault.getAddress(), bn("300"));

      await vault.connect(alice).deposit(bn("100"));
      await vault.connect(bob).deposit(bn("200"));
      await vault.connect(carol).deposit(bn("300"));

      await vault.connect(bob).withdrawAll();
      expect(await vault.balanceOf(bob.address)).to.eq(0n);

      await doc.connect(other).approve(await vault.getAddress(), bn("150"));
      await vault.connect(other).deposit(bn("150"));

      await doc.mint(await strategy.getAddress(), bn("100"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await vault.connect(keeper).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      const seed = ethers.id("reuse-index-seed");
      await vault.connect(owner).awardDrawManual(1n, seed);

      const [wc, winnersFixed] = await vault.getWinners(1n);
      const winnersCount = Number(wc);
      const winnersArr = winnersFixed as unknown as [string, string, string];
      const winners = winnersArr.slice(0, winnersCount);

      for (const w of winners) {
        expect(w.toLowerCase()).to.not.eq(bob.address.toLowerCase());
      }

      const allowed = [
        alice.address.toLowerCase(),
        carol.address.toLowerCase(),
        other.address.toLowerCase(),
      ];
      for (const w of winners) {
        expect(allowed).to.include(w.toLowerCase());
      }
    });

    it("awardDrawFromBtc: reverts BridgeNotSet when bridge=0", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("10"));
      await vault.connect(alice).deposit(bn("10"));

      await doc.mint(await strategy.getAddress(), bn("1"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await vault.connect(owner).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      await expect(vault.awardDrawFromBtc(1n))
        .to.be.revertedWithCustomError(vault, "BridgeNotSet");
    });

    it("option A: whale dominance may return fewer than 3 winners, but never reverts and winners remain distinct", async () => {
      const { vault, strategy, owner, alice, bob, carol, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      const vaultAddr = await vault.getAddress();

      const whale = bn("1000000");
      const minnow = bn("1");

      // Alice whale, Bob y Carol minnows
      await doc.connect(alice).approve(vaultAddr, whale);
      await vault.connect(alice).deposit(whale);

      await doc.connect(bob).approve(vaultAddr, minnow);
      await vault.connect(bob).deposit(minnow);

      await doc.connect(carol).approve(vaultAddr, minnow);
      await vault.connect(carol).deposit(minnow);

      await doc.mint(await strategy.getAddress(), bn("10"));

      await advanceToDrawEnd(vault);

      await vault.connect(owner).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      const seed = ethers.id("whale-bounded-rejection-seed");
      await expect(vault.connect(owner).awardDrawManual(1n, seed))
        .to.emit(vault, "DrawAwarded");

      const [wc, winnersFixed] = await vault.getWinners(1n);
      const winnersCount = Number(wc);
      const winnersArr = (winnersFixed as unknown as string[])
        .slice(0, winnersCount)
        .map((w) => w.toLowerCase());

      expect(winnersCount).to.be.gte(1);
      expect(winnersCount).to.be.lte(3);
      expect(uniq(winnersArr).length).to.eq(winnersCount);

      for (const w of winnersArr) {
        expect([
          alice.address.toLowerCase(),
          bob.address.toLowerCase(),
          carol.address.toLowerCase(),
        ]).to.include(w);
      }
    });
    it("claimDraw with 0 winners rolls undistributed prize into the next draw yield", async () => {
      const { vault, strategy, owner, treasury, keeper, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // Alice deposits after cutoff => ineligible
      await advancePastCutoff(vault);

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      // generate yield so draw closes locked
      await doc.mint(await strategy.getAddress(), bn("40"));

      await advanceToDrawEnd(vault);

      await vault.connect(owner).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      const dClosed = await vault.draws(1n);
      const treasFee = dClosed.treasuryFee;
      const keepTip = dClosed.keeperTip;
      const prize = dClosed.prize;

      expect(prize).to.be.gt(0n);

      // No eligible winners
      const seed = ethers.id("zero-winners-rollover-seed");
      await vault.connect(owner).awardDrawManual(1n, seed);

      const [wc, , prizes] = await vault.getWinners(1n);
      expect(Number(wc)).to.eq(0);
      expect(prizes[0]).to.eq(0n);
      expect(prizes[1]).to.eq(0n);
      expect(prizes[2]).to.eq(0n);

      const preTreas = await doc.balanceOf(treasury.address);
      const preKeeper = await doc.balanceOf(keeper.address);

      await vault.connect(keeper).claimDraw(1n);

      // treasury + keeper still get paid
      expect((await doc.balanceOf(treasury.address)) - preTreas).to.eq(treasFee);
      expect((await doc.balanceOf(keeper.address)) - preKeeper).to.eq(keepTip);

      // draw completed and next one started
      expect(await vault.isLocked()).to.eq(false);
      expect(await vault.currentDrawId()).to.eq(2n);

      // prize stays idle in vault and becomes next draw yield
      expect(await doc.balanceOf(await vault.getAddress())).to.eq(prize);
      expect(await vault.currentYield()).to.eq(prize);
    });
  });

  //TYKO-08  -  2026 04 21
  describe("TYKO-08 treasury transfer fallback", function () {
    it("claimDraw: failing treasury transfer falls back to prizeOwed and does not lock the vault", async () => {
      const [owner, treasury, keeper, alice] = await ethers.getSigners();

      const MockBlacklistERC20 = await ethers.getContractFactory("MockBlacklistERC20");
      const token = await MockBlacklistERC20.deploy("Mock DOC", "DOC");
      await token.waitForDeployment();

      const PrizeVault = await ethers.getContractFactory("PrizeVault");
      const vault = await PrizeVault.deploy(
        await token.getAddress(),
        "TYKORA Share",
        "tDOC",
        owner.address,
        treasury.address,
        TEST_DRAW_PERIOD,
        TEST_MIN_HOLD,
        TEST_TREASURY_BPS,
        TEST_KEEPER_BPS,
        TEST_BTC_CONFIRMATIONS,
        TEST_EMERGENCY_DELAY,
        ethers.ZeroAddress
      );
      await vault.waitForDeployment();

      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const strategy = await MockStrategy.deploy(
        await vault.getAddress(),
        await token.getAddress()
      );
      await strategy.waitForDeployment();

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // one participant
      await token.mint(alice.address, bn("1000"));
      await token.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      // generate yield in strategy
      await token.mint(await strategy.getAddress(), bn("10"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await vault.connect(owner).closeDraw();

      const dClosed = await vault.draws(1n);
      const treasFee = dClosed.treasuryFee;
      const prize = dClosed.prize;

      expect(treasFee).to.be.gt(0n);
      expect(prize).to.be.gt(0n);

      // blacklist treasury so transfer to treasury fails during claimDraw
      await token.setBlocked(treasury.address, true);

      const seed = ethers.id("tyko-08-treasury-fallback");
      await vault.connect(owner).awardDrawManual(1n, seed);

      await expect(vault.connect(keeper).claimDraw(1n))
        .to.emit(vault, "PrizeOwed")
        .withArgs(treasury.address, treasFee);

      const dClaimed = await vault.draws(1n);
      expect(Number(dClaimed.status)).to.eq(CLAIMED);
      expect(await vault.isLocked()).to.eq(false);
      expect(await vault.currentDrawId()).to.eq(2n);

      // treasury amount should be pending instead of blocking the draw
      expect(await vault.prizeOwed(treasury.address)).to.eq(treasFee);

      // winner still receives prize
      expect(await token.balanceOf(alice.address)).to.eq(bn("900") + prize);

      // treasury can claim later once unblocked
      await token.setBlocked(treasury.address, false);

      await expect(vault.connect(treasury).claimOwed())
        .to.emit(vault, "PrizeClaimed")
        .withArgs(treasury.address, treasFee);

      expect(await vault.prizeOwed(treasury.address)).to.eq(0n);
    });
  });
  //TYKO-08  -  2026 04 21 END

  describe("emergencyCancelDraw", function () {
    //TYKO-02  -  2026 04 20
    it("reverts when emergency mode is disabled", async () => {
      const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await doc.mint(await strategy.getAddress(), bn("50"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await vault.connect(owner).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      await expect(vault.connect(owner).emergencyCancelDraw(1n))
        .to.be.revertedWithCustomError(vault, "EmergencyModeDisabled");
    });
    //TYKO-02  -  2026 04 20 END

    it("reverts before emergencyDelay, then cancels and starts next draw", async () => {
      const { vault, strategy, owner, alice, doc, emergencyDelay } =
        await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
      await vault.connect(alice).deposit(bn("100"));

      await doc.mint(await strategy.getAddress(), bn("50"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await vault.connect(owner).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      //TYKO-01  -  2026 04 20
      // New: If there is no active emergency mode, it must first fail because of that.
      await expect(vault.connect(owner).emergencyCancelDraw(1n))
        .to.be.revertedWithCustomError(vault, "EmergencyModeDisabled");

      await vault.connect(owner).setEmergencyMode(true);
      //TYKO-01  -  2026 04 20 END

      await expect(vault.connect(owner).emergencyCancelDraw(1n))
        .to.be.revertedWithCustomError(vault, "EmergencyDelayNotPassed");

      const d1 = await vault.draws(1n);
      const unlockAt = BigInt(d1.closedAt) + BigInt(emergencyDelay);
      await time.increaseTo(unlockAt + 1n);

      const vaultBalBefore = await doc.balanceOf(await vault.getAddress());
      expect(vaultBalBefore).to.be.gt(0n);

      await expect(vault.connect(owner).emergencyCancelDraw(1n))
        .to.emit(vault, "DrawCancelled");

      expect(await vault.isLocked()).to.eq(false);
      expect(await vault.currentDrawId()).to.eq(2n);

      expect(await doc.balanceOf(await vault.getAddress())).to.eq(0n);
    });
  });

  describe("claimOwed", function () {
    it("no-op when owed is 0 (smoke)", async () => {
      const { vault, alice } = await loadFixture(fixture);
      await vault.connect(alice).claimOwed();
    });
  });

  it("withdraw: reverts with VaultLocked when draw is CLOSED (locked)", async () => {
    const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

    await vault.connect(owner).setStrategy(await strategy.getAddress());

    await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
    await vault.connect(alice).deposit(bn("100"));

    await doc.mint(await strategy.getAddress(), bn("10"));

    const end = await vault.drawEndTimestamp();
    await time.increaseTo(end + 1n);

    await vault.connect(owner).closeDraw();
    expect(await vault.isLocked()).to.eq(true);

    await expect(vault.connect(alice).withdraw(bn("1")))
      .to.be.revertedWithCustomError(vault, "VaultLocked");
  });

  it("emergencyCancelDraw: works in AWARDED and counts delay from awardedAt", async () => {
    const { vault, strategy, owner, keeper, alice, doc, emergencyDelay } = await loadFixture(fixture);

    await vault.connect(owner).setStrategy(await strategy.getAddress());

    await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
    await vault.connect(alice).deposit(bn("100"));

    await doc.mint(await strategy.getAddress(), bn("50"));

    const end = await vault.drawEndTimestamp();
    await time.increaseTo(end + 1n);

    await vault.connect(keeper).closeDraw();
    expect(await vault.isLocked()).to.eq(true);

    const seed = ethers.id("seed-awarded-emergency");
    await vault.connect(owner).awardDrawManual(1n, seed);

    const d = await vault.draws(1n);
    expect(Number(d.status)).to.eq(AWARDED);
    expect(d.awardedAt).to.not.eq(0n);

    //TYKO-02  -  2026 04 20
    // NEW: now requires emergency mode to be active
    await expect(vault.connect(owner).emergencyCancelDraw(1n))
      .to.be.revertedWithCustomError(vault, "EmergencyModeDisabled");

    await vault.connect(owner).setEmergencyMode(true);
    //TYKO-02  -  2026 04 20 END

    await expect(vault.connect(owner).emergencyCancelDraw(1n))
      .to.be.revertedWithCustomError(vault, "EmergencyDelayNotPassed");

    const unlockAt = BigInt(d.awardedAt) + BigInt(emergencyDelay);
    await time.increaseTo(unlockAt + 1n);

    await expect(vault.connect(owner).emergencyCancelDraw(1n))
      .to.emit(vault, "DrawCancelled");

    expect(await vault.isLocked()).to.eq(false);
    expect(await vault.currentDrawId()).to.eq(2n);
  });

  it("emergencyCancelDraw: onlyOwner", async () => {
    const { vault, strategy, owner, keeper, alice, doc } = await loadFixture(fixture);

    await vault.connect(owner).setStrategy(await strategy.getAddress());

    await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
    await vault.connect(alice).deposit(bn("100"));
    await doc.mint(await strategy.getAddress(), bn("10"));

    const end = await vault.drawEndTimestamp();
    await time.increaseTo(end + 1n);

    await vault.connect(owner).closeDraw();
    expect(await vault.isLocked()).to.eq(true);

    await vault.connect(owner).setEmergencyMode(true);//TYKO-02  -  2026 04 20

    await expect(vault.connect(keeper).emergencyCancelDraw(1n))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
      .withArgs(keeper.address);
  });

  it("emergencyMode blocks deposit/withdraw/close and tickets remain consistent", async () => { //TYKO-01  -  2026 04 20
    const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

    await vault.connect(owner).setStrategy(await strategy.getAddress());

    await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
    await vault.connect(alice).deposit(bn("100"));

    expect(await vault.totalPrincipal()).to.eq(bn("100"));
    expect(await vault.totalTickets()).to.eq(bn("100"));

    await vault.connect(owner).setEmergencyMode(true);

    await doc.connect(alice).approve(await vault.getAddress(), bn("1"));
    await expect(vault.connect(alice).deposit(bn("1")))
      .to.be.revertedWithCustomError(vault, "EmergencyModeEnabled");

    await expect(vault.connect(owner).closeDraw())
      .to.be.revertedWithCustomError(vault, "EmergencyModeEnabled");

    //TYKO-02  -  2026 04 20
    await expect(vault.connect(alice).withdraw(bn("40")))
      .to.be.revertedWithCustomError(vault, "EmergencyModeEnabled");

    await expect(vault.connect(alice).withdrawAll())
      .to.be.revertedWithCustomError(vault, "EmergencyModeEnabled");

    // There is no desync: main and tickets remain the same
    expect(await vault.totalPrincipal()).to.eq(bn("100"));
    expect(await vault.totalTickets()).to.eq(bn("100"));

    await vault.connect(owner).setEmergencyMode(false);

    expect(await vault.totalTickets()).to.eq(await vault.totalPrincipal());
    expect(await vault.totalTickets()).to.eq(bn("100"));
    //TYKO-02  -  2026 04 20 END
  });

  it("fenwick repair: blocks deposit/withdraw/close while in progress", async () => {
    const { vault, strategy, owner, alice, doc } = await loadFixture(fixture);

    await vault.connect(owner).setStrategy(await strategy.getAddress());
    await doc.connect(alice).approve(await vault.getAddress(), bn("10"));
    await vault.connect(alice).deposit(bn("10"));

    await vault.connect(owner).startFenwickRepair();

    await doc.connect(alice).approve(await vault.getAddress(), bn("1"));
    await expect(vault.connect(alice).deposit(bn("1")))
      .to.be.revertedWithCustomError(vault, "FenwickRepairInProgress");

    await expect(vault.connect(alice).withdraw(bn("1")))
      .to.be.revertedWithCustomError(vault, "FenwickRepairInProgress");

    await expect(vault.connect(owner).closeDraw())
      .to.be.revertedWithCustomError(vault, "FenwickRepairInProgress");
  });
  describe("sponsors / noTickets", function () {
    it("setNoTickets: onlyOwner, blocks zero/locked/emergency", async () => {
      const { vault, strategy, owner, keeper, alice, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // onlyOwner
      await expect(vault.connect(keeper).setNoTickets(alice.address, true))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(keeper.address);

      // zero addr
      await expect(vault.connect(owner).setNoTickets(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");

      // emergency blocks
      await vault.connect(owner).setEmergencyMode(true);
      await expect(vault.connect(owner).setNoTickets(alice.address, true))
        .to.be.revertedWithCustomError(vault, "EmergencyModeEnabled");
      await vault.connect(owner).setEmergencyMode(false);

      // lock blocks
      await doc.connect(alice).approve(await vault.getAddress(), bn("10"));
      await vault.connect(alice).deposit(bn("10"));
      await doc.mint(await strategy.getAddress(), bn("1")); // yield>0 so it locks

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);
      await vault.connect(keeper).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      await expect(vault.connect(owner).setNoTickets(alice.address, true))
        .to.be.revertedWithCustomError(vault, "VaultLocked");
    });

    it("sponsor deposits do NOT create tickets; toggling restores tickets", async () => {
      const { vault, strategy, owner, alice, bob, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // mark alice as sponsor
      await expect(vault.connect(owner).setNoTickets(alice.address, true))
        .to.emit(vault, "NoTicketsSet")
        .withArgs(alice.address, true);

      await doc.connect(alice).approve(await vault.getAddress(), bn("1000"));
      await doc.connect(bob).approve(await vault.getAddress(), bn("200"));

      await vault.connect(alice).deposit(bn("1000"));
      await vault.connect(bob).deposit(bn("200"));

      // principal includes both
      expect(await vault.totalPrincipal()).to.eq(bn("1200"));

      // tickets exclude sponsor
      expect(await vault.totalTickets()).to.eq(bn("200"));

      // now enable alice tickets again => tickets should include her balance
      await vault.connect(owner).setNoTickets(alice.address, false);
      expect(await vault.totalTickets()).to.eq(bn("1200"));

      // disable again
      await vault.connect(owner).setNoTickets(alice.address, true);
      expect(await vault.totalTickets()).to.eq(bn("200"));
    });

    it("sponsor can NEVER be picked as winner (even if whale)", async () => {
      const { vault, strategy, owner, keeper, alice, bob, carol, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      // Alice is whale sponsor
      await vault.connect(owner).setNoTickets(alice.address, true);

      await doc.connect(alice).approve(await vault.getAddress(), bn("1000000"));
      await doc.connect(bob).approve(await vault.getAddress(), bn("10"));
      await doc.connect(carol).approve(await vault.getAddress(), bn("10"));

      await vault.connect(alice).deposit(bn("1000000"));
      await vault.connect(bob).deposit(bn("10"));
      await vault.connect(carol).deposit(bn("10"));

      // tickets should only be bob+carol
      expect(await vault.totalTickets()).to.eq(bn("20"));

      // create yield so it locks
      await doc.mint(await strategy.getAddress(), bn("100"));

      const end = await vault.drawEndTimestamp();
      await time.increaseTo(end + 1n);

      await vault.connect(keeper).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      const seed = ethers.id("seed-sponsor-excluded");
      await vault.connect(owner).awardDrawManual(1n, seed);

      const [wc, winnersFixed] = await vault.getWinners(1n);
      const winnersCount = Number(wc);
      const winnersArr = winnersFixed as unknown as [string, string, string];
      const winners = winnersArr.slice(0, winnersCount).map(w => w.toLowerCase());

      expect(winners).to.not.include(alice.address.toLowerCase());
      for (const w of winners) {
        expect([bob.address.toLowerCase(), carol.address.toLowerCase()]).to.include(w);
      }
    });
  });
  // TYKO-03 -  2026 04 21   
  it("awardDrawManual: reverts when bridge is configured", async () => {
    const [owner, treasury, keeper, alice] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const doc = await MockERC20.deploy("Mock DOC", "DOC", 18);
    await doc.waitForDeployment();

    await doc.mint(alice.address, bn("1000"));

    const MockBridge = await ethers.getContractFactory("MockBridge");
    const bridge = await MockBridge.deploy();
    await bridge.waitForDeployment();

    const PrizeVault = await ethers.getContractFactory("PrizeVault");
    const vault = await PrizeVault.deploy(
      await doc.getAddress(),
      "TYKORA Share",
      "tDOC",
      owner.address,
      treasury.address,
      TEST_DRAW_PERIOD,
      TEST_MIN_HOLD,
      TEST_TREASURY_BPS,
      TEST_KEEPER_BPS,
      TEST_BTC_CONFIRMATIONS,
      TEST_EMERGENCY_DELAY,
      await bridge.getAddress()
    );
    await vault.waitForDeployment();

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const strategy = await MockStrategy.deploy(
      await vault.getAddress(),
      await doc.getAddress()
    );
    await strategy.waitForDeployment();

    await vault.connect(owner).setStrategy(await strategy.getAddress());

    await doc.connect(alice).approve(await vault.getAddress(), bn("100"));
    await vault.connect(alice).deposit(bn("100"));

    await doc.mint(await strategy.getAddress(), bn("10"));

    const end = await vault.drawEndTimestamp();
    await time.increaseTo(end + 1n);

    await vault.connect(owner).closeDraw();

    await expect(
      vault.connect(owner).awardDrawManual(1n, ethers.id("manual-seed"))
    ).to.be.revertedWithCustomError(vault, "ManualAwardDisabled");
  });
  // TYKO-03 -  2026 04 21 END
});