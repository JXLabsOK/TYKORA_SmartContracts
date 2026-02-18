import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const OPEN = 0;
const CLOSED = 1;
const AWARDED = 2;
const CLAIMED = 3;

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

async function advanceToEndAndMature(vault: any) {
  const end = await vault.drawEndTimestamp();
  const hold = await vault.minHoldForEligibility(); // bigint
  await time.increaseTo(end + 1n + hold);
}

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
    const drawPeriod = 100; // seconds
    const treasuryBps = 900; // 9%
    const keeperBps = 100; // 1%
    const btcConfirmations = 6;
    const emergencyDelay = 200; // seconds
    const minHoldForEligibilitySeconds = 24 * 60 * 60; // minHoldForEligibilitySeconds (24hs)

    const vault = await PrizeVault.deploy(
      await doc.getAddress(),
      "TYKORA Share",
      "tDOC",
      owner.address,
      treasury.address,
      drawPeriod,
      minHoldForEligibilitySeconds,
      treasuryBps,
      keeperBps,
      btcConfirmations,
      emergencyDelay,
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
      drawPeriod,
      treasuryBps,
      keeperBps,
      emergencyDelay,
    };
  }

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
          100,
          24 * 60 * 60,
          900,
          100,
          6,
          200,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "ZeroAddress");

      // owner = 0 => OZ OwnableInvalidOwner(0x0) (reverts before our ZeroAddress check)
      await expect(
        PrizeVault.deploy(
          await doc.getAddress(),
          "Share",
          "s",
          ethers.ZeroAddress,
          treasury.address,
          100,
          24 * 60 * 60,
          900,
          100,
          6,
          200,
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
          100,
          24 * 60 * 60,
          900,
          100,
          6,
          200,
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
          24 * 60 * 60,
          900,
          100,
          6,
          200,
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
          100,
          24 * 60 * 60,
          9000,
          2000,
          6,
          200,
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
          100,
          24 * 60 * 60,
          900,
          100,
          6,
          0,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(PrizeVault, "InvalidBps");
    });

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

    it("option A: whale dominance can return winnersCount < 3 (deterministic seed search)", async () => {
      const { vault, strategy, owner, alice, bob, carol, doc } = await loadFixture(fixture);

      await vault.connect(owner).setStrategy(await strategy.getAddress());

      const vaultAddr = await vault.getAddress();

      const whale = bn("1000000");
      const minnow = bn("1");

      // Whale first => index 1
      await doc.connect(alice).approve(vaultAddr, whale);
      await vault.connect(alice).deposit(whale);

      await doc.connect(bob).approve(vaultAddr, minnow);
      await vault.connect(bob).deposit(minnow);

      await doc.connect(carol).approve(vaultAddr, minnow);
      await vault.connect(carol).deposit(minnow);

      await doc.mint(await strategy.getAddress(), bn("10"));

      await advanceToEndAndMature(vault);

      await vault.connect(owner).closeDraw();
      expect(await vault.isLocked()).to.eq(true);

      const tickets = await vault.totalTickets();
      expect(tickets).to.eq(whale + minnow + minnow);

      let foundSeed: string | null = null;

      const maxTries = 64; // must match contract
      const maxSeedsToTry = 200;

      for (let k = 0; k < maxSeedsToTry; k++) {
        const seed = ethers.id("whale-seed-" + k);

        const h0 = ethers.solidityPackedKeccak256(["bytes32", "uint8", "uint8"], [seed, 0, 0]);
        const r0 = BigInt(h0) % tickets;
        if (r0 >= whale) continue;

        let ok = true;

        for (let i = 1; i <= 2 && ok; i++) {
          for (let a = 0; a < maxTries; a++) {
            const h = ethers.solidityPackedKeccak256(["bytes32", "uint8", "uint8"], [seed, i, a]);
            const r = BigInt(h) % tickets;
            if (r >= whale) {
              ok = false;
              break;
            }
          }
        }

        if (ok) {
          foundSeed = seed;
          break;
        }
      }

      expect(foundSeed).to.not.eq(null);

      await vault.connect(owner).awardDrawManual(1n, foundSeed!);

      const [wc, winnersFixed] = await vault.getWinners(1n);
      const winnersCount = Number(wc);
      const winnersArr = winnersFixed as unknown as [string, string, string];

      expect(winnersCount).to.eq(1);
      expect(winnersArr[0].toLowerCase()).to.eq(alice.address.toLowerCase());
    });
  });

  describe("emergencyCancelDraw", function () {
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

    await expect(vault.connect(keeper).emergencyCancelDraw(1n))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
      .withArgs(keeper.address);
  });

  it("emergencyMode: deposit/close blocked, withdraw allowed, tickets go stale; repair fixes tickets", async () => {
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

    await vault.connect(alice).withdraw(bn("40"));
    expect(await vault.totalPrincipal()).to.eq(bn("60"));
    expect(await vault.totalTickets()).to.eq(bn("100")); // stale on purpose

    await vault.connect(owner).setEmergencyMode(false);

    await vault.connect(owner).startFenwickRepair();
    await vault.connect(owner).continueFenwickRepair(1_000_000);
    await vault.connect(owner).continueFenwickRepair(1_000_000);

    expect(await vault.totalTickets()).to.eq(await vault.totalPrincipal());
    expect(await vault.totalTickets()).to.eq(bn("60"));
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

});