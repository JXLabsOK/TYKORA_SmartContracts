import { expect } from "chai";
import { ethers } from "hardhat";

describe("TropykusDoCStrategy", function () {
  async function deploy() {
    const [deployer, vault, alice, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const underlying = await MockERC20.deploy("DOC", "DOC", 18);
    await underlying.waitForDeployment();

    // Tropykus: exchangeRate is ALWAYS scaled by 1e18. Strategy uses RATE_SCALE = 1e18.
    // In the MockKToken, rateScale is derived from decimals; with uDec=18, kDec=18 => rateScale=1e18.
    const MockKToken = await ethers.getContractFactory("MockKToken");
    const kToken = await MockKToken.deploy(
      await underlying.getAddress(),
      "kDOC",
      "kDOC",
      18,
      ethers.parseUnits("1", 18)
    );
    await kToken.waitForDeployment();

    const Strategy = await ethers.getContractFactory("TropykusDoCStrategy");
    const strategy = await Strategy.deploy(
      vault.address,
      await underlying.getAddress(),
      await kToken.getAddress()
    );
    await strategy.waitForDeployment();

    return { deployer, vault, alice, bob, underlying, kToken, strategy };
  }

  it("constructor: reverts on zero addresses", async () => {
    const [_, vault] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const u = await MockERC20.deploy("DOC", "DOC", 18);
    await u.waitForDeployment();

    const MockKToken = await ethers.getContractFactory("MockKToken");
    const k = await MockKToken.deploy(
      await u.getAddress(),
      "kDOC",
      "kDOC",
      18,
      ethers.parseUnits("1", 18)
    );
    await k.waitForDeployment();

    const Strategy = await ethers.getContractFactory("TropykusDoCStrategy");

    await expect(
      Strategy.deploy(ethers.ZeroAddress, await u.getAddress(), await k.getAddress())
    ).to.be.revertedWithCustomError(Strategy, "ZeroAddress");

    await expect(
      Strategy.deploy(vault.address, ethers.ZeroAddress, await k.getAddress())
    ).to.be.revertedWithCustomError(Strategy, "ZeroAddress");

    await expect(
      Strategy.deploy(vault.address, await u.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(Strategy, "ZeroAddress");
  });

  it("constructor: reverts if kToken.underlying() mismatch", async () => {
    const [_, vault] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const u1 = await MockERC20.deploy("DOC", "DOC", 18);
    const u2 = await MockERC20.deploy("OTHER", "OTH", 18);
    await u1.waitForDeployment();
    await u2.waitForDeployment();

    const MockKToken = await ethers.getContractFactory("MockKToken");
    // kToken underlying = u2 (mismatch)
    const k = await MockKToken.deploy(
      await u2.getAddress(),
      "kDOC",
      "kDOC",
      18,
      ethers.parseUnits("1", 18)
    );
    await k.waitForDeployment();

    const Strategy = await ethers.getContractFactory("TropykusDoCStrategy");

    await expect(
      Strategy.deploy(vault.address, await u1.getAddress(), await k.getAddress())
    )
      .to.be.revertedWithCustomError(Strategy, "UnderlyingMismatch")
      .withArgs(await u1.getAddress(), await u2.getAddress());
  });

  it("constructor: sets MAX allowance from strategy to kToken (one-time approve)", async () => {
    const { underlying, kToken, strategy } = await deploy();

    const allowance = await underlying.allowance(
      await strategy.getAddress(),
      await kToken.getAddress()
    );

    expect(allowance).to.equal(ethers.MaxUint256);
  });

  it("onlyVault: blocks accrue/deposit/withdrawUnderlying/withdrawAll/recoverERC20", async () => {
    const { alice, underlying, strategy } = await deploy();

    await expect(strategy.connect(alice).accrue())
      .to.be.revertedWithCustomError(strategy, "OnlyVault");

    await expect(strategy.connect(alice).deposit(1n))
      .to.be.revertedWithCustomError(strategy, "OnlyVault");

    await expect(strategy.connect(alice).withdrawUnderlying(1n, alice.address))
      .to.be.revertedWithCustomError(strategy, "OnlyVault");

    await expect(strategy.connect(alice).withdrawAll(alice.address))
      .to.be.revertedWithCustomError(strategy, "OnlyVault");

    await expect(
      strategy.connect(alice).recoverERC20(await underlying.getAddress(), alice.address, 1n)
    ).to.be.revertedWithCustomError(strategy, "OnlyVault");
  });

  it("accrue(): returns exchangeRateCurrent, updates lastExchangeRate; falls back to stored on revert", async () => {
    const { vault, kToken, strategy } = await deploy();

    // 1) static call validates return value
    const r1 = await strategy.connect(vault).accrue.staticCall();
    expect(r1).to.equal(ethers.parseUnits("1", 18));

    // 2) tx validates state update
    await strategy.connect(vault).accrue();
    expect(await strategy.lastExchangeRate()).to.equal(ethers.parseUnits("1", 18));

    // move rate and verify update
    await kToken.setExchangeRate(ethers.parseUnits("1.05", 18));
    await strategy.connect(vault).accrue();
    expect(await strategy.lastExchangeRate()).to.equal(ethers.parseUnits("1.05", 18));

    // force exchangeRateCurrent revert => strategy should fallback to stored
    await kToken.setRevertExchangeRateCurrent(true);

    const r2 = await strategy.connect(vault).accrue.staticCall();
    expect(r2).to.equal(ethers.parseUnits("1.05", 18)); // fallback to stored (same in mock)

    await strategy.connect(vault).accrue();
    expect(await strategy.lastExchangeRate()).to.equal(ethers.parseUnits("1.05", 18));
  });

  it("deposit(): pulls underlying from vault, mints kTokens, emits Deposited", async () => {
    const { vault, underlying, kToken, strategy } = await deploy();

    const amount = ethers.parseUnits("100", 18);

    await underlying.mint(vault.address, amount);
    // vault must approve strategy (strategy does transferFrom(vault -> strategy))
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);

    await expect(strategy.connect(vault).deposit(amount))
      .to.emit(strategy, "Deposited")
      .withArgs(amount, amount); // with 1:1 rate, minted == amount

    // with 1:1 rate, kTokens minted == amount
    const kBal = await kToken.balanceOf(await strategy.getAddress());
    expect(kBal).to.equal(amount);

    // underlying should end up inside kToken (mock pulls it there on mint)
    const underlyingInK = await underlying.balanceOf(await kToken.getAddress());
    expect(underlyingInK).to.equal(amount);
  });

  it("deposit(): reverts on ZeroAmount and MintFailed(code)", async () => {
    const { vault, underlying, kToken, strategy } = await deploy();

    await expect(strategy.connect(vault).deposit(0n))
      .to.be.revertedWithCustomError(strategy, "ZeroAmount");

    const amount = ethers.parseUnits("1", 18);
    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);

    await kToken.setReturnCodes(7, 0, 0); // mintCode=7
    await expect(strategy.connect(vault).deposit(amount))
      .to.be.revertedWithCustomError(strategy, "MintFailed")
      .withArgs(7);
  });

  it("totalUnderlying(): uses cached lastExchangeRate; without accrue it does NOT reflect exchangeRate changes", async () => {
    const { vault, underlying, kToken, strategy } = await deploy();

    const amount = ethers.parseUnits("100", 18);
    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    // initial rate is 1.0 (cached in constructor). Should match principal.
    const tu0 = await strategy.totalUnderlying();
    expect(tu0).to.equal(amount);

    // simulate yield by changing exchangeRate in kToken to 1.1
    await kToken.setExchangeRate(ethers.parseUnits("1.1", 18));

    // WITHOUT accrue(), totalUnderlying still uses cached lastExchangeRate => still amount
    const tuNoAccrue = await strategy.totalUnderlying();
    expect(tuNoAccrue).to.equal(amount);

    // Now accrue() updates lastExchangeRate => totalUnderlying reflects 110
    await strategy.connect(vault).accrue();
    const tuAccrued = await strategy.totalUnderlying();
    expect(tuAccrued).to.equal(ethers.parseUnits("110", 18));
  });

  it("withdrawUnderlying(): redeems underlying and transfers to recipient", async () => {
    const { vault, alice, underlying, kToken, strategy } = await deploy();

    const amount = ethers.parseUnits("100", 18);
    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    const w = ethers.parseUnits("40", 18);

    await expect(strategy.connect(vault).withdrawUnderlying(w, alice.address))
      .to.emit(strategy, "Withdrawn")
      .withArgs(w, alice.address);

    const aliceBal = await underlying.balanceOf(alice.address);
    expect(aliceBal).to.equal(w);

    // strategy kToken balance should have decreased by w (1:1 rate)
    const kBal = await kToken.balanceOf(await strategy.getAddress());
    expect(kBal).to.equal(amount - w);
  });

  it("withdrawUnderlying(): reverts on ZeroAmount, ZeroAddress, RedeemUnderlyingFailed(code)", async () => {
    const { vault, alice, underlying, kToken, strategy } = await deploy();

    await expect(strategy.connect(vault).withdrawUnderlying(0n, alice.address))
      .to.be.revertedWithCustomError(strategy, "ZeroAmount");

    await expect(strategy.connect(vault).withdrawUnderlying(1n, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(strategy, "ZeroAddress");

    const amount = ethers.parseUnits("10", 18);
    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    await kToken.setReturnCodes(0, 0, 9); // redeemUnderlyingCode=9
    await expect(strategy.connect(vault).withdrawUnderlying(1n, alice.address))
      .to.be.revertedWithCustomError(strategy, "RedeemUnderlyingFailed")
      .withArgs(9);
  });

  it("withdrawAll(): reverts on ZeroAddress", async () => {
    const { vault, strategy } = await deploy();
    await expect(strategy.connect(vault).withdrawAll(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(strategy, "ZeroAddress");
  });

  it("withdrawAll(): reverts on RedeemFailed(code)", async () => {
    const { vault, bob, underlying, kToken, strategy } = await deploy();

    const amount = ethers.parseUnits("50", 18);
    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    await kToken.setReturnCodes(0, 8, 0); // redeemCode=8
    await expect(strategy.connect(vault).withdrawAll(bob.address))
      .to.be.revertedWithCustomError(strategy, "RedeemFailed")
      .withArgs(8);
  });

  it("withdrawAll(): redeems all kTokens and transfers all underlying to recipient", async () => {
    const { vault, bob, underlying, kToken, strategy } = await deploy();

    const amount = ethers.parseUnits("50", 18);
    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    await expect(strategy.connect(vault).withdrawAll(bob.address))
      .to.emit(strategy, "WithdrawAll")
      .withArgs(amount, bob.address);

    const bobBal = await underlying.balanceOf(bob.address);
    expect(bobBal).to.equal(amount);

    const kBal = await kToken.balanceOf(await strategy.getAddress());
    expect(kBal).to.equal(0n);
  });

  it("recoverERC20(): cannot recover underlying, can recover other tokens", async () => {
    const { vault, alice, underlying, strategy } = await deploy();

    await expect(
      strategy.connect(vault).recoverERC20(await underlying.getAddress(), alice.address, 1n)
    ).to.be.revertedWithCustomError(strategy, "RecoverNotAllowed");

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const other = await MockERC20.deploy("OTHER", "OTH", 18);
    await other.waitForDeployment();

    const amount = ethers.parseUnits("5", 18);
    await other.mint(await strategy.getAddress(), amount);

    await expect(
      strategy.connect(vault).recoverERC20(await other.getAddress(), alice.address, amount)
    )
      .to.emit(strategy, "Recovered")
      .withArgs(await other.getAddress(), amount, alice.address);

    expect(await other.balanceOf(alice.address)).to.equal(amount);
  });
});