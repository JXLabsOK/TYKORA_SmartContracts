import { expect } from "chai";
import { ethers } from "hardhat";

describe("SovrynDoCStrategy", function () {
  const ONE = ethers.parseUnits("1", 18);

  async function deploy() {
    const [deployer, vault, alice, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const underlying = await MockERC20.deploy("DOC", "DOC", 18);
    await underlying.waitForDeployment();

    const MockSovrynIToken = await ethers.getContractFactory("MockSovrynIToken");
    const iToken = await MockSovrynIToken.deploy(
      await underlying.getAddress(),
      "iDOC",
      "iDOC",
      ONE
    );
    await iToken.waitForDeployment();

    const Strategy = await ethers.getContractFactory("SovrynDoCStrategy");
    const strategy = await Strategy.deploy(
      vault.address,
      await underlying.getAddress(),
      await iToken.getAddress()
    );
    await strategy.waitForDeployment();

    return { deployer, vault, alice, bob, underlying, iToken, strategy };
  }

  it("constructor: reverts on zero addresses", async () => {
    const [_, vault] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const u = await MockERC20.deploy("DOC", "DOC", 18);
    await u.waitForDeployment();

    const MockSovrynIToken = await ethers.getContractFactory("MockSovrynIToken");
    const i = await MockSovrynIToken.deploy(
      await u.getAddress(),
      "iDOC",
      "iDOC",
      ONE
    );
    await i.waitForDeployment();

    const Strategy = await ethers.getContractFactory("SovrynDoCStrategy");

    await expect(
      Strategy.deploy(ethers.ZeroAddress, await u.getAddress(), await i.getAddress())
    ).to.be.revertedWithCustomError(Strategy, "ZeroAddress");

    await expect(
      Strategy.deploy(vault.address, ethers.ZeroAddress, await i.getAddress())
    ).to.be.revertedWithCustomError(Strategy, "ZeroAddress");

    await expect(
      Strategy.deploy(vault.address, await u.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(Strategy, "ZeroAddress");
  });

  it("constructor: reverts if iToken.loanTokenAddress() mismatch", async () => {
    const [_, vault] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const u1 = await MockERC20.deploy("DOC", "DOC", 18);
    const u2 = await MockERC20.deploy("OTHER", "OTH", 18);
    await u1.waitForDeployment();
    await u2.waitForDeployment();

    const MockSovrynIToken = await ethers.getContractFactory("MockSovrynIToken");

    // iToken underlying = u2, but strategy receives u1
    const i = await MockSovrynIToken.deploy(
      await u2.getAddress(),
      "iDOC",
      "iDOC",
      ONE
    );
    await i.waitForDeployment();

    const Strategy = await ethers.getContractFactory("SovrynDoCStrategy");

    await expect(
      Strategy.deploy(vault.address, await u1.getAddress(), await i.getAddress())
    )
      .to.be.revertedWithCustomError(Strategy, "UnderlyingMismatch")
      .withArgs(await u1.getAddress(), await u2.getAddress());
  });

  it("constructor: reverts if initial tokenPrice is zero", async () => {
    const [_, vault] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const u = await MockERC20.deploy("DOC", "DOC", 18);
    await u.waitForDeployment();

    const MockSovrynIToken = await ethers.getContractFactory("MockSovrynIToken");
    const i = await MockSovrynIToken.deploy(
      await u.getAddress(),
      "iDOC",
      "iDOC",
      0n
    );
    await i.waitForDeployment();

    const Strategy = await ethers.getContractFactory("SovrynDoCStrategy");

    await expect(
      Strategy.deploy(vault.address, await u.getAddress(), await i.getAddress())
    ).to.be.revertedWithCustomError(Strategy, "InvalidTokenPrice");
  });

  it("constructor: sets MAX allowance from strategy to iToken", async () => {
    const { underlying, iToken, strategy } = await deploy();

    const allowance = await underlying.allowance(
      await strategy.getAddress(),
      await iToken.getAddress()
    );

    expect(allowance).to.equal(ethers.MaxUint256);
  });

  it("underlying(): returns underlying token address", async () => {
    const { underlying, strategy } = await deploy();

    expect(await strategy.underlying()).to.equal(await underlying.getAddress());
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

  it("accrue(): updates lastTokenPrice and emits Accrued", async () => {
    const { vault, iToken, strategy } = await deploy();

    expect(await strategy.lastTokenPrice()).to.equal(ONE);

    const newPrice = ethers.parseUnits("1.05", 18);
    await iToken.setTokenPrice(newPrice);

    await expect(strategy.connect(vault).accrue())
      .to.emit(strategy, "Accrued")
      .withArgs(newPrice);

    expect(await strategy.lastTokenPrice()).to.equal(newPrice);
  });

  it("accrue(): reverts if tokenPrice is zero", async () => {
    const { vault, iToken, strategy } = await deploy();

    await iToken.setTokenPrice(0n);

    await expect(strategy.connect(vault).accrue())
      .to.be.revertedWithCustomError(strategy, "InvalidTokenPrice");
  });

  it("deposit(): pulls underlying from vault, mints iTokens, emits Deposited", async () => {
    const { vault, underlying, iToken, strategy } = await deploy();

    const amount = ethers.parseUnits("100", 18);

    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);

    await expect(strategy.connect(vault).deposit(amount))
      .to.emit(strategy, "Deposited")
      .withArgs(amount, amount);

    const iBal = await iToken.balanceOf(await strategy.getAddress());
    expect(iBal).to.equal(amount);

    const underlyingInIToken = await underlying.balanceOf(await iToken.getAddress());
    expect(underlyingInIToken).to.equal(amount);

    expect(await strategy.lastTokenPrice()).to.equal(ONE);
  });

  it("deposit(): reverts on ZeroAmount and MintFailed", async () => {
    const { vault, underlying, iToken, strategy } = await deploy();

    await expect(strategy.connect(vault).deposit(0n))
      .to.be.revertedWithCustomError(strategy, "ZeroAmount");

    const amount = ethers.parseUnits("1", 18);
    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);

    await iToken.setMintZero(true);

    await expect(strategy.connect(vault).deposit(amount))
      .to.be.revertedWithCustomError(strategy, "MintFailed");
  });

  it("totalUnderlying(): uses cached lastTokenPrice; without accrue it does not reflect tokenPrice changes", async () => {
    const { vault, underlying, iToken, strategy } = await deploy();

    const amount = ethers.parseUnits("100", 18);

    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    expect(await strategy.totalUnderlying()).to.equal(amount);

    await iToken.setTokenPrice(ethers.parseUnits("1.1", 18));

    // Cached lastTokenPrice is still 1.0
    expect(await strategy.totalUnderlying()).to.equal(amount);

    await strategy.connect(vault).accrue();

    expect(await strategy.totalUnderlying()).to.equal(ethers.parseUnits("110", 18));
  });

  it("currentUnderlying(): uses live assetBalanceOf", async () => {
    const { vault, underlying, iToken, strategy } = await deploy();

    const amount = ethers.parseUnits("100", 18);

    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    await iToken.setTokenPrice(ethers.parseUnits("1.2", 18));

    expect(await strategy.currentUnderlying()).to.equal(ethers.parseUnits("120", 18));
  });

  it("availableLiquidity(): returns idle underlying plus Sovryn market liquidity", async () => {
    const { underlying, iToken, strategy } = await deploy();

    const idle = ethers.parseUnits("3", 18);
    const marketLiquidity = ethers.parseUnits("50", 18);

    await underlying.mint(await strategy.getAddress(), idle);
    await iToken.setMarketLiquidity(marketLiquidity);

    expect(await strategy.availableLiquidity()).to.equal(idle + marketLiquidity);
  });

  it("previewBurnAmount(): uses cached lastTokenPrice and rounds up", async () => {
    const { vault, iToken, strategy } = await deploy();

    await iToken.setTokenPrice(ethers.parseUnits("1.1", 18));
    await strategy.connect(vault).accrue();

    const underlyingAmount = ethers.parseUnits("11", 18);
    const expectedBurn = ethers.parseUnits("10", 18);

    expect(await strategy.previewBurnAmount(underlyingAmount)).to.equal(expectedBurn);
  });

  it("withdrawUnderlying(): burns iTokens, redeems underlying and transfers to recipient", async () => {
    const { vault, alice, underlying, iToken, strategy } = await deploy();

    const amount = ethers.parseUnits("100", 18);

    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    const w = ethers.parseUnits("40", 18);

    await expect(strategy.connect(vault).withdrawUnderlying(w, alice.address))
      .to.emit(strategy, "Withdrawn")
      .withArgs(w, w, w, alice.address);

    expect(await underlying.balanceOf(alice.address)).to.equal(w);
    expect(await iToken.balanceOf(await strategy.getAddress())).to.equal(amount - w);
  });

  it("withdrawUnderlying(): uses idle underlying first before burning iTokens", async () => {
    const { vault, alice, underlying, iToken, strategy } = await deploy();

    const amount = ethers.parseUnits("100", 18);
    const idle = ethers.parseUnits("10", 18);
    const withdrawAmount = ethers.parseUnits("5", 18);

    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    await underlying.mint(await strategy.getAddress(), idle);

    await expect(strategy.connect(vault).withdrawUnderlying(withdrawAmount, alice.address))
      .to.emit(strategy, "Withdrawn")
      .withArgs(withdrawAmount, 0n, 0n, alice.address);

    expect(await underlying.balanceOf(alice.address)).to.equal(withdrawAmount);
    expect(await iToken.balanceOf(await strategy.getAddress())).to.equal(amount);
  });

  it("withdrawUnderlying(): reverts on ZeroAmount and ZeroAddress", async () => {
    const { vault, alice, strategy } = await deploy();

    await expect(strategy.connect(vault).withdrawUnderlying(0n, alice.address))
      .to.be.revertedWithCustomError(strategy, "ZeroAmount");

    await expect(strategy.connect(vault).withdrawUnderlying(1n, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(strategy, "ZeroAddress");
  });

  it("withdrawUnderlying(): reverts on BurnFailed if burn redeems zero", async () => {
    const { vault, alice, underlying, iToken, strategy } = await deploy();

    const amount = ethers.parseUnits("10", 18);

    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    await iToken.setBurnNoRedeem(true);

    await expect(strategy.connect(vault).withdrawUnderlying(1n, alice.address))
      .to.be.revertedWithCustomError(strategy, "BurnFailed");
  });

  it("withdrawUnderlying(): reverts with InsufficientUnderlying if not enough assets", async () => {
    const { vault, alice, underlying, strategy } = await deploy();

    const idle = ethers.parseUnits("2", 18);
    const requested = ethers.parseUnits("5", 18);

    await underlying.mint(await strategy.getAddress(), idle);

    await expect(strategy.connect(vault).withdrawUnderlying(requested, alice.address))
      .to.be.revertedWithCustomError(strategy, "InsufficientUnderlying")
      .withArgs(requested, idle);
  });

  it("withdrawAll(): reverts on ZeroAddress", async () => {
    const { vault, strategy } = await deploy();

    await expect(strategy.connect(vault).withdrawAll(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(strategy, "ZeroAddress");
  });

  it("withdrawAll(): reverts on BurnFailed if burn redeems zero", async () => {
    const { vault, bob, underlying, iToken, strategy } = await deploy();

    const amount = ethers.parseUnits("50", 18);

    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    await iToken.setBurnNoRedeem(true);

    await expect(strategy.connect(vault).withdrawAll(bob.address))
      .to.be.revertedWithCustomError(strategy, "BurnFailed");
  });

  it("withdrawAll(): burns all iTokens and transfers all underlying to recipient", async () => {
    const { vault, bob, underlying, iToken, strategy } = await deploy();

    const amount = ethers.parseUnits("50", 18);

    await underlying.mint(vault.address, amount);
    await underlying.connect(vault).approve(await strategy.getAddress(), amount);
    await strategy.connect(vault).deposit(amount);

    await expect(strategy.connect(vault).withdrawAll(bob.address))
      .to.emit(strategy, "WithdrawAll")
      .withArgs(amount, amount, bob.address);

    expect(await underlying.balanceOf(bob.address)).to.equal(amount);
    expect(await iToken.balanceOf(await strategy.getAddress())).to.equal(0n);
  });

  it("recoverERC20(): cannot recover underlying or iToken, can recover other tokens", async () => {
    const { vault, alice, underlying, iToken, strategy } = await deploy();

    await expect(
      strategy.connect(vault).recoverERC20(await underlying.getAddress(), alice.address, 1n)
    ).to.be.revertedWithCustomError(strategy, "RecoverNotAllowed");

    await expect(
      strategy.connect(vault).recoverERC20(await iToken.getAddress(), alice.address, 1n)
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

  it("recoverERC20(): reverts on ZeroAddress and ZeroAmount", async () => {
    const { vault, alice, strategy } = await deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const other = await MockERC20.deploy("OTHER", "OTH", 18);
    await other.waitForDeployment();

    await expect(
      strategy.connect(vault).recoverERC20(await other.getAddress(), ethers.ZeroAddress, 1n)
    ).to.be.revertedWithCustomError(strategy, "ZeroAddress");

    await expect(
      strategy.connect(vault).recoverERC20(await other.getAddress(), alice.address, 0n)
    ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
  });
});