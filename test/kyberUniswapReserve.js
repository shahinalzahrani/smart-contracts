const web3 = require("web3");

const BigNumber = require("bignumber.js");

require("chai")
    .use(require("chai-as-promised"))
    .use(require("chai-bignumber")(BigNumber))
    .should();

const helper = require("./helper.js");

const truffleAssert = require("truffle-assertions");

const MockUniswapFactory = artifacts.require("MockUniswapFactory");
const KyberUniswapReserve = artifacts.require("TestingKyberUniswapReserve");
const TestToken = artifacts.require("TestToken");

const ETH_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const KYBER_MAX_QTY = new BigNumber(10).pow(28); // 10B tokens

let DEFAULT_FEE_BPS;

let DEBUG = false;

let uniswapFactoryMock;
let reserve;

let token;

let admin;
let operator;
let alerter;
let bank;
let user;
let kyberNetwork;

contract("KyberUniswapReserve", async accounts => {
    const deployToken = async (
        name = "Some Token",
        symbol = "KNC",
        decimals = 18
    ) => {
        const token = await TestToken.new(name, symbol, decimals, {
            from: bank
        });
        dbg(
            `Deployed test token with ${decimals} decimals at ${token.address}`
        );
        return token;
    };

    const prepareUniswapFactory = async token => {
        const uniswapFactory = await MockUniswapFactory.new();
        dbg(`UniswapFactoryMock deployed to address ${uniswapFactory.address}`);

        const bigAmount = new BigNumber(10).pow(18).mul(100);
        await helper.sendEtherWithPromise(
            admin /* sender */,
            uniswapFactory.address /* recv */,
            bigAmount /* amount */
        );

        // TODO: maybe do this after listing the token
        token.transfer(uniswapFactory.address, bigAmount, { from: bank });

        return uniswapFactory;
    };

    const emptyReserveAccounts = async () => {
        const ethBalance = await helper.getBalancePromise(reserve.address);
        await reserve.withdrawEther(ethBalance, bank, { from: admin });

        const tokenBalance = await token.balanceOf(reserve.address);
        await reserve.withdrawToken(token.address, tokenBalance, bank, {
            from: admin
        });
    };

    const applyInternalInventoryHintToRate = (rate, useInternalInventory) => {
        const requiredLastDigit = useInternalInventory ? 1 : 0;
        let rateWithHint = new BigNumber(rate);
        return rateWithHint.mod(2).equals(requiredLastDigit)
            ? rateWithHint
            : rateWithHint.sub(1);
    };

    const assertRateHintUseInternalInventory = (
        rate,
        shouldUseInternalInventory
    ) => {
        const rateLastDigit = rate.mod(2);
        return rateLastDigit.should.be.bignumber.eq(
            shouldUseInternalInventory ? 1 : 0
        );
    };

    before("setup", async () => {
        admin = accounts[1];
        operator = accounts[2];
        alerter = accounts[3];
        bank = accounts[4];
        user = accounts[5];
        kyberNetwork = accounts[6];

        token = await deployToken();

        uniswapFactoryMock = await prepareUniswapFactory(token);
        reserve = await KyberUniswapReserve.new(
            uniswapFactoryMock.address /* uniswap */,
            admin /* admin */,
            kyberNetwork /* kyberNetwork */,
            { from: admin }
        );
        dbg(`KyberUniswapReserve deployed to address ${reserve.address}`);

        reserve.addOperator(operator, { from: admin });

        // Fund KyberNetwork
        await token.transfer(kyberNetwork, new BigNumber(10).pow(18).mul(100), {
            from: bank
        });
        await token.approve(reserve.address, 2 ** 255, { from: kyberNetwork });

        DEFAULT_FEE_BPS = await reserve.DEFAULT_FEE_BPS();

        await reserve.listToken(token.address, { from: admin });

        await reserve.addAlerter(alerter, { from: admin });
    });

    beforeEach("setup contract for each test", async () => {
        await reserve.enableTrade({ from: admin });
        await reserve.setFee(DEFAULT_FEE_BPS, { from: admin });

        // internal inventory disabled by default
        await reserve.setInternalActivationConfig(
            token.address /* token */,
            0 /* minSpreadBps */,
            0 /* premiumBps */,
            { from: admin }
        );

        // internal inventory balance limits also disable it
        await reserve.setInternalInventoryLimits(
            token.address /* token */,
            2 ** 255 /* minBalance */,
            0 /* maxBalance */,
            { from: operator }
        );

        await emptyReserveAccounts();

        await uniswapFactoryMock.setToken(token.address);
        await uniswapFactoryMock.setRateEthToToken(1, 1);
        await uniswapFactoryMock.setRateTokenToEth(1, 1);
    });

    describe("constructor params", () => {
        it("UniswapFactory must not be 0", async () => {
            await truffleAssert.reverts(
                KyberUniswapReserve.new(
                    0 /* _uniswapFactory */,
                    admin,
                    kyberNetwork,
                    {
                        from: admin
                    }
                )
            );
        });

        it("admin must not be 0", async () => {
            await truffleAssert.reverts(
                KyberUniswapReserve.new(
                    uniswapFactoryMock.address,
                    0 /* _admin */,
                    kyberNetwork,
                    { from: admin }
                )
            );
        });

        it("kyberNetwork must not be 0", async () => {
            await truffleAssert.reverts(
                KyberUniswapReserve.new(
                    uniswapFactoryMock.address,
                    admin /* _admin */,
                    0 /* kyberNetwork */,
                    { from: admin }
                )
            );
        });

        it("UniswapFactory is saved", async () => {
            const uniswapFactoryAddress =
                "0x0000000000000000000000000000000000000001";
            const newReserve = await KyberUniswapReserve.new(
                uniswapFactoryAddress,
                admin,
                kyberNetwork,
                { from: admin }
            );

            const uniswapFactory = await newReserve.uniswapFactory();
            uniswapFactory.should.be.eq(uniswapFactoryAddress);
        });

        it("admin is saved", async () => {
            const otherAdmin = "0x0000000000000000000000000000000000000001";
            const newReserve = await KyberUniswapReserve.new(
                uniswapFactoryMock.address,
                otherAdmin,
                kyberNetwork,
                { from: admin }
            );

            const adminValue = await newReserve.admin();
            adminValue.should.be.eq(otherAdmin);
        });

        it("kyberNetwork is saved", async () => {
            const kyberNetwork = "0x0000000000000000000000000000000000000001";
            const newReserve = await KyberUniswapReserve.new(
                uniswapFactoryMock.address,
                admin,
                kyberNetwork,
                { from: admin }
            );

            const kyberNetworkAddress = await newReserve.kyberNetwork();
            kyberNetworkAddress.should.be.eq(kyberNetwork);
        });
    });

    describe("Misc", () => {
        it("should be able to send ETH to reserve", async () => {
            await helper.sendEtherWithPromise(
                admin /* sender */,
                reserve.address /* recv */,
                1 /* amount */
            );
        });

        it("should allow admin to withdraw tokens", async () => {
            const amount = web3.utils.toWei("1");
            const initialWethBalance = await token.balanceOf(admin);

            await token.transfer(reserve.address, amount, { from: bank });
            const res = await reserve.withdrawToken(
                token.address,
                amount,
                admin,
                {
                    from: admin
                }
            );

            const balance = await token.balanceOf(admin);
            balance.should.be.bignumber.eq(initialWethBalance.plus(amount));

            truffleAssert.eventEmitted(res, "TokenWithdraw", ev => {
                return (
                    ev.token === token.address &&
                    ev.amount.eq(amount) &&
                    ev.sendTo === admin
                );
            });
        });

        it("reject withdrawing tokens by non-admin users", async () => {
            const amount = web3.utils.toWei("1");
            await token.transfer(reserve.address, amount, { from: bank });

            await truffleAssert.reverts(
                reserve.withdrawToken(token.address, amount, user, {
                    from: user
                })
            );
        });
    });

    describe("#getConversionRate", () => {
        it("conversion rate 1:1", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                1 /* token */
            );

            const rate = await reserve.getConversionRate(
                ETH_TOKEN_ADDRESS /* src */,
                token.address /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(new BigNumber(10).pow(18));
        });

        it("conversion rate eth -> token of 1:2", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                2 /* token */
            );

            const rate = await reserve.getConversionRate(
                ETH_TOKEN_ADDRESS /* src */,
                token.address /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            // kyber rates are destQty / srcQty
            rate.should.be.bignumber.eq(new BigNumber(10).pow(18).mul(2));
        });

        it("conversion rate eth -> token of 2:1", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                2 /* eth */,
                1 /* token */
            );

            const rate = await reserve.getConversionRate(
                ETH_TOKEN_ADDRESS /* src */,
                token.address /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(new BigNumber(10).pow(18).mul(0.5));
        });

        it("conversion rate token -> eth of 2:1", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                2 /* token */
            );

            const rate = await reserve.getConversionRate(
                token.address /* src */,
                ETH_TOKEN_ADDRESS /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(new BigNumber(10).pow(18).mul(0.5));
        });

        it("conversion rate token -> eth of 1:2", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                2 /* eth */,
                1 /* token */
            );

            const rate = await reserve.getConversionRate(
                token.address /* src */,
                ETH_TOKEN_ADDRESS /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(new BigNumber(10).pow(18).mul(2));
        });

        it("conversion between a non-18 decimals token and ETH");
        it("conversion between ETH and a non-18 decimals token");

        it("fail if both tokens are ETH", async () => {
            const rate = await reserve.getConversionRate(
                ETH_TOKEN_ADDRESS /* src */,
                ETH_TOKEN_ADDRESS /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(0);
        });

        it("fail if both tokens are not ETH", async () => {
            const rate = await reserve.getConversionRate(
                token.address /* src */,
                token.address /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(0);
        });

        it("fail for unsupported tokens", async () => {
            const newToken = await deployToken();

            const rate = await reserve.getConversionRate(
                newToken.address /* src */,
                ETH_TOKEN_ADDRESS /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(0);
        });

        it("conversion rate eth -> token of 1:2, with 1% fees", async () => {
            await reserve.setFee(100, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                2 /* token */
            );

            const rate = await reserve.getConversionRate(
                ETH_TOKEN_ADDRESS /* src */,
                token.address /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            // kyber rates are destQty / srcQty
            rate.should.be.bignumber.eq(
                new BigNumber(10)
                    .pow(18)
                    .mul(0.99)
                    .mul(2)
            );
        });

        it("conversion rate token -> eth of 2:1, with 5% fees", async () => {
            await reserve.setFee(500, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                2 /* token */
            );

            const rate = await reserve.getConversionRate(
                token.address /* src */,
                ETH_TOKEN_ADDRESS /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(
                new BigNumber(10)
                    .pow(18)
                    .mul(0.95)
                    .div(2)
            );
        });

        it("returns 0 if trade is disabled", async () => {
            await reserve.setFee(500, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                2 /* token */
            );

            await reserve.disableTrade({ from: alerter });

            const rate = await reserve.getConversionRate(
                token.address /* src */,
                ETH_TOKEN_ADDRESS /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(0);
        });

        it("internal inventory: ETH -> Token 1:2, with 1% fees, 100 premiumBps", async () => {
            await reserve.setFee(100, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                10 /* eth */,
                20 /* token */
            );
            await uniswapFactoryMock.setRateTokenToEth(
                10 /* eth */,
                24 /* token */
            );

            // minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                100 /* premiumBps */,
                { from: admin }
            );

            // disable internal inventory limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                0 /* minBalance */,
                2 ** 255 /* maxBalance */,
                { from: operator }
            );

            await token.transfer(reserve.address, web3.utils.toWei("5"), {
                from: bank
            });

            const rate = await reserve.getConversionRate(
                ETH_TOKEN_ADDRESS /* src */,
                token.address /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            // kyber rates are destQty / srcQty
            rate.should.be.bignumber.eq(
                applyInternalInventoryHintToRate(
                    new BigNumber(10)
                        .pow(18)
                        .mul(2) // rate
                        .mul(0.99) // fee
                        .mul(1.01), // premiumBps
                    true /* useInternalInventory */
                )
            );

            assertRateHintUseInternalInventory(
                rate,
                true /* shouldUseInternalInventory */
            );
        });

        it("internal inventory: Token -> ETH 2:1, with 5% fees, 100 premiumBps", async () => {
            await reserve.setFee(500, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                10 /* eth */,
                20 /* token */
            );
            await uniswapFactoryMock.setRateEthToToken(
                10 /* eth */,
                18 /* token */
            );

            // minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                100 /* premiumBps */,
                { from: admin }
            );

            // disable internal inventory limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                0 /* minBalance */,
                2 ** 255 /* maxBalance */,
                { from: operator }
            );
            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("5") /* amount */
            );

            const rate = await reserve.getConversionRate(
                token.address /* src */,
                ETH_TOKEN_ADDRESS /* dst */,
                web3.utils.toWei("1") /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(
                applyInternalInventoryHintToRate(
                    new BigNumber(10)
                        .pow(18)
                        .mul(0.5) // rate
                        .mul(0.95) // fee
                        .mul(1.01), // premiumBps
                    true /* useInternalInventory */
                )
            );

            assertRateHintUseInternalInventory(
                rate,
                true /* shouldUseInternalInventory */
            );
        });

        it("srcQty 0 -> rate of 0", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                1 /* token */
            );

            const rate = await reserve.getConversionRate(
                ETH_TOKEN_ADDRESS /* src */,
                token.address /* dst */,
                0 /* srcQty */,
                0 /* blockNumber */
            );

            rate.should.be.bignumber.eq(0);
        });

        it("Token -> ETH, low spread, not using internal inventory", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                26 /* eth */,
                10 /* token */
            );
            await uniswapFactoryMock.setRateTokenToEth(
                25 /* eth */,
                10 /* token */
            );
            const amountToken = web3.utils.toWei("0.1");

            // Prepare the reserve's internal inventory
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                0 /* minBalance */,
                2 ** 255 /* maxBalance */,
                { from: operator }
            );

            // 1/10 ETH is actually required
            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("1") /* amount */
            );

            const rate = await reserve.getConversionRate(
                token.address /* src */,
                ETH_TOKEN_ADDRESS /* dest */,
                amountToken /* srcQty */,
                0 /* blockNumber */
            );

            assertRateHintUseInternalInventory(
                rate,
                false /* shouldUseInternalInventory */
            );
        });
    });

    describe("#trade", () => {
        it("can be called from KyberNetwork", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10).pow(18);

            await reserve.trade(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* dstToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );
        });

        it("can not be called by user other than KyberNetwork", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10).pow(18);

            await truffleAssert.reverts(
                reserve.trade(
                    ETH_TOKEN_ADDRESS /* srcToken */,
                    amount /* srcAmount */,
                    token.address /* dstToken */,
                    user /* destAddress */,
                    conversionRate /* conversionRate */,
                    true /* validate */,
                    { from: user, value: amount }
                )
            );
        });

        it("fail if ETH in src and dest", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10).pow(18);

            await truffleAssert.reverts(
                reserve.trade(
                    ETH_TOKEN_ADDRESS /* srcToken */,
                    amount /* srcAmount */,
                    ETH_TOKEN_ADDRESS /* destToken */,
                    kyberNetwork /* destAddress */,
                    conversionRate /* conversionRate */,
                    true /* validate */,
                    { from: kyberNetwork, value: amount }
                )
            );
        });

        it("fail if token in both src and dest", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10).pow(18);

            await truffleAssert.reverts(
                reserve.trade(
                    token.address /* srcToken */,
                    amount /* srcAmount */,
                    token.address /* destToken */,
                    user /* destAddress */,
                    conversionRate /* conversionRate */,
                    true /* validate */,
                    { from: kyberNetwork }
                )
            );
        });

        it("simple trade eth -> token", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10).pow(18);
            const tokenBalanceBefore = await token.balanceOf(kyberNetwork);

            const traded = await reserve.trade.call(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* destToken */,
                kyberNetwork /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );
            await reserve.trade(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* destToken */,
                kyberNetwork /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );

            const tokenBalanceAfter = await token.balanceOf(kyberNetwork);

            traded.should.be.true;
            tokenBalanceAfter.should.be.bignumber.eq(
                tokenBalanceBefore.add(amount)
            );
        });

        it("simple trade token -> ETH", async () => {
            await reserve.setFee(0, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10).pow(18);
            const ethBalanceBefore = await helper.getBalancePromise(user);

            const traded = await reserve.trade.call(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );
            await reserve.trade(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );

            const ethBalanceAfter = await helper.getBalancePromise(user);

            traded.should.be.true;
            ethBalanceAfter.should.be.bignumber.eq(
                ethBalanceBefore.add(amount)
            );
        });

        it("trade eth -> token with 0.25% fee", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10).pow(18).mul(0.9975);
            const tokenBalanceBefore = await token.balanceOf(kyberNetwork);

            const traded = await reserve.trade.call(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* destToken */,
                kyberNetwork /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );
            await reserve.trade(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* destToken */,
                kyberNetwork /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );

            const tokenBalanceAfter = await token.balanceOf(kyberNetwork);
            const expectedBalance = tokenBalanceBefore.add(amount * 0.9975);

            traded.should.be.true;
            tokenBalanceAfter.should.be.bignumber.eq(expectedBalance);
        });

        it("trade token -> ETH with 0.25% fee", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10).pow(18).mul(0.9975);
            const ethBalanceBefore = await helper.getBalancePromise(user);

            const traded = await reserve.trade.call(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );
            await reserve.trade(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );

            const ethBalanceAfter = await helper.getBalancePromise(user);

            traded.should.be.true;
            ethBalanceAfter.should.be.bignumber.eq(
                ethBalanceBefore.add(amount * 0.9975)
            );
        });

        it("trade eth -> token with rate 1:2 and 0.25% fee", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                2 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10)
                .pow(18)
                .mul(2)
                .mul(0.9975);
            const tokenBalanceBefore = await token.balanceOf(kyberNetwork);

            const traded = await reserve.trade.call(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* destToken */,
                kyberNetwork /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );
            await reserve.trade(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* destToken */,
                kyberNetwork /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );

            const tokenBalanceAfter = await token.balanceOf(kyberNetwork);
            const expectedBalance = tokenBalanceBefore.add(amount * 2 * 0.9975);

            traded.should.be.true;
            tokenBalanceAfter.should.be.bignumber.eq(expectedBalance);
        });

        it("trade token -> ETH with rate 1:2 and 0.25% fee", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                2 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10)
                .pow(18)
                .mul(2)
                .mul(0.9975);
            const ethBalanceBefore = await helper.getBalancePromise(user);

            const traded = await reserve.trade.call(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );
            await reserve.trade(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );

            const ethBalanceAfter = await helper.getBalancePromise(user);

            traded.should.be.true;
            ethBalanceAfter.should.be.bignumber.eq(
                ethBalanceBefore.add(amount * 2 * 0.9975)
            );
        });

        it("fail if actual trade rate < conversionRate param", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                2 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");

            const expectedConversionRate = await reserve.getConversionRate(
                token.address /* src */,
                ETH_TOKEN_ADDRESS /* dest */,
                amount /* srcQty */,
                0 /* blockNumber */
            );

            await truffleAssert.reverts(
                reserve.trade(
                    token.address /* srcToken */,
                    amount /* srcAmount */,
                    ETH_TOKEN_ADDRESS /* destToken */,
                    user /* destAddress */,
                    expectedConversionRate.plus(1) /* conversionRate */,
                    true /* validate */,
                    { from: kyberNetwork }
                )
            );
        });

        it("ETH -> token, fail if srcAmount != msg.value", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                2 /* token */
            );
            const amount = new BigNumber(10).pow(18);
            const conversionRate = new BigNumber(10)
                .pow(18)
                .mul(2)
                .mul(0.9975);

            await truffleAssert.reverts(
                reserve.trade(
                    ETH_TOKEN_ADDRESS /* srcToken */,
                    amount /* srcAmount */,
                    token.address /* destToken */,
                    kyberNetwork /* destAddress */,
                    conversionRate /* conversionRate */,
                    true /* validate */,
                    { from: kyberNetwork, value: amount.sub(1) }
                )
            );
        });

        it("Token -> ETH, fail if msg.value != 0", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                2 /* token */
            );
            const amount = new BigNumber(10).pow(18);
            const conversionRate = new BigNumber(10)
                .pow(18)
                .mul(0.5)
                .mul(0.9975);

            await truffleAssert.reverts(
                reserve.trade(
                    token.address /* srcToken */,
                    amount /* srcAmount */,
                    ETH_TOKEN_ADDRESS /* destToken */,
                    kyberNetwork /* destAddress */,
                    conversionRate /* conversionRate */,
                    true /* validate */,
                    { from: kyberNetwork, value: 1 }
                )
            );
        });

        it("fail if trade is disabled", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                2 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10)
                .pow(18)
                .mul(2)
                .mul(0.9975);
            await reserve.disableTrade({ from: alerter });

            await truffleAssert.reverts(
                reserve.trade(
                    ETH_TOKEN_ADDRESS /* srcToken */,
                    amount /* srcAmount */,
                    token.address /* destToken */,
                    kyberNetwork /* destAddress */,
                    conversionRate /* conversionRate */,
                    true /* validate */,
                    { from: kyberNetwork, value: amount }
                )
            );
        });

        it("trade event emitted", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateTokenToEth(
                2 /* eth */,
                1 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = new BigNumber(10)
                .pow(18)
                .mul(2)
                .mul(0.9975);

            const res = await reserve.trade(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );

            truffleAssert.eventEmitted(res, "TradeExecute", ev => {
                return (
                    ev.sender === kyberNetwork &&
                    ev.src === token.address &&
                    ev.srcAmount.eq(new BigNumber(amount)) &&
                    ev.destToken === ETH_TOKEN_ADDRESS &&
                    ev.destAmount.eq(
                        new BigNumber(10)
                            .pow(18)
                            .mul(2)
                            .mul(0.9975)
                    ) &&
                    ev.destAddress === user &&
                    ev.useInternalInventory === false
                );
            });
        });

        it("Token -> ETH using internal inventory", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                9 /* token */
            );
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                10 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = applyInternalInventoryHintToRate(
                new BigNumber(10)
                    .pow(18)
                    .div(10)
                    .mul(0.9975),
                true /* useInternalInventory */
            );
            // Prepare the reserve's internal inventory
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                0 /* minBalance */,
                2 ** 255 /* maxBalance */,
                { from: operator }
            );

            // 1/10 ETH is actually required
            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("1") /* amount */
            );

            // Read balance before
            const reserveEthBefore = await helper.getBalancePromise(
                reserve.address
            );
            const reserveTokenBefore = await token.balanceOf(reserve.address);
            const uniswapMockEthBefore = await helper.getBalancePromise(
                uniswapFactoryMock.address
            );
            const uniswapMockTokenBefore = await token.balanceOf(
                uniswapFactoryMock.address
            );

            const traded = await reserve.trade.call(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );
            await reserve.trade(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );

            const reserveEthAfter = await helper.getBalancePromise(
                reserve.address
            );
            const reserveTokenAfter = await token.balanceOf(reserve.address);
            const uniswapMockEthAfter = await helper.getBalancePromise(
                uniswapFactoryMock.address
            );
            const uniswapMockTokenAfter = await token.balanceOf(
                uniswapFactoryMock.address
            );

            traded.should.be.true;
            reserveEthAfter.should.be.bignumber.eq(
                reserveEthBefore.sub(
                    new BigNumber(10)
                        .pow(18)
                        .div(10)
                        .mul(0.9975)
                        .sub(1) // internal inventory hint
                )
            );
            reserveTokenAfter.should.be.bignumber.eq(
                reserveTokenBefore.add(new BigNumber(10).pow(18))
            );
            uniswapMockEthAfter.should.be.bignumber.eq(uniswapMockEthBefore);
            uniswapMockTokenAfter.should.be.bignumber.eq(
                uniswapMockTokenBefore
            );
        });

        it("ETH -> Token using internal inventory", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                9 /* token */
            );
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                10 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = applyInternalInventoryHintToRate(
                new BigNumber(10)
                    .pow(18)
                    .mul(9)
                    .mul(0.9975),
                true /* useInternalInventory */
            );

            // Prepare the reserve's internal inventory
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                0 /* minBalance */,
                2 ** 255 /* maxBalance */,
                { from: operator }
            );

            await token.transfer(reserve.address, web3.utils.toWei("20"), {
                from: bank
            });

            // Read balance before
            const reserveEthBefore = await helper.getBalancePromise(
                reserve.address
            );
            const reserveTokenBefore = await token.balanceOf(reserve.address);

            const traded = await reserve.trade.call(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );
            await reserve.trade(
                ETH_TOKEN_ADDRESS /* srcToken */,
                amount /* srcAmount */,
                token.address /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork, value: amount }
            );

            const reserveEthAfter = await helper.getBalancePromise(
                reserve.address
            );
            const reserveTokenAfter = await token.balanceOf(reserve.address);

            traded.should.be.true;
            reserveEthAfter.should.be.bignumber.eq(
                reserveEthBefore.add(amount)
            );
            reserveTokenAfter.should.be.bignumber.eq(
                reserveTokenBefore.sub(
                    new BigNumber(amount)
                        .mul(9)
                        .mul(0.9975)
                        .sub(1) // internal inventory hint
                )
            );
        });

        it("TradeExecute event indicates internal inventory used", async () => {
            await reserve.setFee(25, { from: admin });
            await uniswapFactoryMock.setRateEthToToken(
                1 /* eth */,
                9 /* token */
            );
            await uniswapFactoryMock.setRateTokenToEth(
                1 /* eth */,
                10 /* token */
            );
            const amount = web3.utils.toWei("1");
            const conversionRate = applyInternalInventoryHintToRate(
                new BigNumber(10)
                    .pow(18)
                    .div(10)
                    .mul(0.9975),
                true /* useInternalInventory */
            );

            // Prepare the reserve's internal inventory
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                0 /* minBalance */,
                2 ** 255 /* maxBalance */,
                { from: operator }
            );

            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("1") /* amount */
            );

            const res = await reserve.trade(
                token.address /* srcToken */,
                amount /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                user /* destAddress */,
                conversionRate /* conversionRate */,
                true /* validate */,
                { from: kyberNetwork }
            );

            truffleAssert.eventEmitted(res, "TradeExecute", ev => {
                return (
                    ev.sender === kyberNetwork &&
                    ev.src === token.address &&
                    ev.srcAmount.eq(new BigNumber(amount)) &&
                    ev.destToken === ETH_TOKEN_ADDRESS &&
                    ev.destAmount.eq(
                        new BigNumber(10)
                            .pow(18)
                            .div(10)
                            .mul(0.9975)
                            .sub(1)
                    ) &&
                    ev.destAddress === user &&
                    ev.useInternalInventory === true
                );
            });
        });
    });

    describe("#setFee", () => {
        it("default fee", async () => {
            const newReserve = await KyberUniswapReserve.new(
                1 /* uniswapFactory */,
                admin,
                kyberNetwork
            );

            const feeValue = await newReserve.feeBps();

            feeValue.should.be.bignumber.eq(DEFAULT_FEE_BPS);
        });

        it("fee value saved", async () => {
            await reserve.setFee(30, { from: admin });

            const feeValue = await reserve.feeBps();
            feeValue.should.be.bignumber.eq(30);
        });

        it("calling by admin allowed", async () => {
            await reserve.setFee(20, { from: admin });
        });

        it("calling by non-admin reverts", async () => {
            await truffleAssert.reverts(reserve.setFee(20, { from: user }));
        });

        it("fail for fee > 10000", async () => {
            await truffleAssert.reverts(reserve.setFee(10001, { from: admin }));
        });

        it("event sent on setFee", async () => {
            const res = await reserve.setFee(20, { from: admin });
            truffleAssert.eventEmitted(res, "FeeUpdated", ev => {
                return ev.bps.eq(20);
            });
        });
    });

    describe("#listToken", () => {
        it("calling by admin allowed", async () => {
            const newToken = await deployToken();

            await reserve.listToken(newToken.address, { from: admin });
        });

        it("calling by non-admin reverts", async () => {
            const newToken = await deployToken();

            await truffleAssert.reverts(
                reserve.listToken(newToken.address, { from: user })
            );
        });

        it("adding token", async () => {
            const newToken = await deployToken();

            await reserve.listToken(newToken.address, { from: admin });

            const exchange = await reserve.tokenExchange(newToken.address);
            exchange.should.not.be.bignumber.eq(0);
        });

        it("listing a token saves its decimals", async () => {
            const newToken = await deployToken(
                "Other Token" /* name */,
                "TKN" /* symbol */,
                10 /* decimals */
            );

            await reserve.listToken(newToken.address, { from: admin });

            const decimals = await reserve.getTokenDecimals(newToken.address);
            decimals.should.be.bignumber.eq(10);
        });

        it("fails for token with address 0", async () => {
            await truffleAssert.reverts(reserve.listToken(0, { from: user }));
        });

        it("event sent on token listed", async () => {
            const newToken = await deployToken();

            const res = await reserve.listToken(newToken.address, {
                from: admin
            });

            const tokenExchange = await uniswapFactoryMock.getExchange(
                newToken.address
            );
            truffleAssert.eventEmitted(res, "TokenListed", ev => {
                return (
                    ev.token === newToken.address &&
                    ev.exchange === tokenExchange
                );
            });
        });

        it("listing a token saves its uniswap exchange address", async () => {
            const newToken = await deployToken();
            const tokenExchange = await uniswapFactoryMock.createExchange.call(
                newToken.address
            );

            await reserve.listToken(newToken.address, { from: admin });

            const exchange = await reserve.tokenExchange(newToken.address);
            exchange.should.be.eq(tokenExchange);
        });

        it("listing token gives allowence to exchange", async () => {
            const newToken = await deployToken();
            const tokenExchange = await uniswapFactoryMock.createExchange.call(
                newToken.address
            );

            await reserve.listToken(newToken.address, { from: admin });

            const amount = await newToken.allowance(
                reserve.address,
                tokenExchange
            );
            amount.should.be.bignumber.eq(new BigNumber(2).pow(255));
        });

        it("should set initial internal inventory defaults", async () => {
            const newToken = await deployToken();
            const tokenExchange = await uniswapFactoryMock.createExchange.call(
                newToken.address
            );

            await reserve.listToken(newToken.address, { from: admin });

            const internalLimitMin = await reserve.internalInventoryMin(
                newToken.address
            );
            const internalLimitMax = await reserve.internalInventoryMax(
                newToken.address
            );
            const activationMinSpread = await reserve.internalActivationMinSpreadBps(
                newToken.address
            );
            const internalPricePremiumBps = await reserve.internalPricePremiumBps(
                newToken.address
            );

            internalLimitMin.should.be.bignumber.eq(new BigNumber(2).pow(255));
            internalLimitMax.should.be.bignumber.eq(0);
            activationMinSpread.should.be.bignumber.eq(0);
            internalPricePremiumBps.should.be.bignumber.eq(0);
        });
    });

    describe("#delistToken", () => {
        it("calling by admin allowed", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await reserve.delistToken(newToken.address, { from: admin });
        });

        it("calling by non-admin reverts", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await truffleAssert.reverts(
                reserve.delistToken(newToken.address, { from: user })
            );
        });

        it("after calling token no longer supported", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await reserve.delistToken(newToken.address, { from: admin });

            const exchange = await reserve.tokenExchange(newToken.address);
            exchange.should.be.bignumber.eq(0);
        });

        it("cannot delist unlisted tokens", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await reserve.delistToken(newToken.address, { from: admin });

            await truffleAssert.reverts(
                reserve.delistToken(newToken.address, { from: admin })
            );
        });

        it("event sent on token delisted", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            const res = await reserve.delistToken(newToken.address, {
                from: admin
            });

            truffleAssert.eventEmitted(res, "TokenDelisted", ev => {
                return ev.token === newToken.address;
            });
        });

        it("calling deletes internal inventory settings", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });
            await reserve.setInternalInventoryLimits(
                newToken.address,
                100 /* minBalance */,
                500 /* maxBalance */,
                { from: operator }
            );
            await reserve.setInternalActivationConfig(
                newToken.address,
                100 /* minSpreadBps */,
                5 /* premiumBps */,
                { from: admin }
            );

            await reserve.delistToken(newToken.address, { from: admin });

            const internalLimitMin = await reserve.internalInventoryMin(
                newToken.address
            );
            const internalLimitMax = await reserve.internalInventoryMax(
                newToken.address
            );
            const activationMinSpread = await reserve.internalActivationMinSpreadBps(
                newToken.address
            );
            const internalPricePremiumBps = await reserve.internalPricePremiumBps(
                newToken.address
            );

            internalLimitMin.should.be.bignumber.eq(0);
            internalLimitMax.should.be.bignumber.eq(0);
            activationMinSpread.should.be.bignumber.eq(0);
            internalPricePremiumBps.should.be.bignumber.eq(0);
        });
    });

    describe("Responsible reserve", () => {
        it("enableTrade() allowed for admin", async () => {
            await reserve.disableTrade({ from: alerter });

            const enabled = await reserve.enableTrade.call({ from: admin });
            await reserve.enableTrade({ from: admin });

            const actuallyEnabled = await reserve.tradeEnabled();
            enabled.should.be.true;
            actuallyEnabled.should.be.true;
        });

        it("enableTrade() fails if not admin", async () => {
            await truffleAssert.reverts(reserve.enableTrade({ from: user }));
        });

        it("event emitted on enableTrade()", async () => {
            const res = await reserve.enableTrade({ from: admin });

            truffleAssert.eventEmitted(res, "TradeEnabled", ev => {
                return ev.enable === true;
            });
        });

        it("disableTrade() allowed for alerter", async () => {
            await reserve.enableTrade({ from: admin });

            const disabled = await reserve.disableTrade.call({ from: alerter });
            await reserve.disableTrade({ from: alerter });

            const tradeEnabled = await reserve.tradeEnabled();
            disabled.should.be.true;
            tradeEnabled.should.be.false;
        });

        it("disableTrade() fails if not alerter", async () => {
            await truffleAssert.reverts(reserve.disableTrade({ from: user }));
        });

        it("event emitted on disableTrade()", async () => {
            const res = await reserve.disableTrade({ from: alerter });

            truffleAssert.eventEmitted(res, "TradeEnabled", ev => {
                return ev.enable === false;
            });
        });
    });

    describe("#setKyberNetwork", () => {
        it("set new value by admin", async () => {
            await reserve.setKyberNetwork(user, { from: admin });

            const updatedKyberNetwork = await reserve.kyberNetwork();
            updatedKyberNetwork.should.be.eq(user);
        });

        it("should reject address 0", async () => {
            await truffleAssert.reverts(reserve.setKyberNetwork(0));
        });

        it("only admin can set values", async () => {
            await truffleAssert.reverts(
                reserve.setKyberNetwork(user, { from: user })
            );
        });

        it("setting value emits an event", async () => {
            const res = await reserve.setKyberNetwork(user, { from: admin });

            await truffleAssert.eventEmitted(res, "KyberNetworkSet", ev => {
                return ev.kyberNetwork === user;
            });
        });
    });

    describe("#setInternalInventoryLimits", () => {
        it("set new value by operator", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await reserve.setInternalInventoryLimits(
                newToken.address /* token */,
                100 /* min */,
                500 /* max */,
                { from: operator }
            );

            const min = await reserve.internalInventoryMin(newToken.address);
            const max = await reserve.internalInventoryMax(newToken.address);
            min.should.be.bignumber.eq(100);
            max.should.be.bignumber.eq(500);
        });

        it("reject if token is unlisted", async () => {
            const newToken = await deployToken();

            await truffleAssert.reverts(
                reserve.setInternalInventoryLimits(
                    newToken.address /* token */,
                    100 /* min */,
                    500 /* max */,
                    { from: operator }
                )
            );
        });

        it("only operator can set values", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await truffleAssert.reverts(
                reserve.setInternalInventoryLimits(
                    newToken.address /* token */,
                    100 /* min */,
                    500 /* max */,
                    { from: user }
                )
            );
        });

        it("setting value emits an event", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            const res = await reserve.setInternalInventoryLimits(
                newToken.address /* token */,
                100 /* min */,
                500 /* max */,
                { from: operator }
            );

            await truffleAssert.eventEmitted(
                res,
                "InternalInventoryLimitsUpdated",
                ev => {
                    return (
                        ev.token === newToken.address &&
                        ev.minBalance.eq(100) &&
                        ev.maxBalance.eq(500)
                    );
                }
            );
        });
    });

    describe("#setInternalActivationConfig", () => {
        it("set new value by admin", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await reserve.setInternalActivationConfig(
                newToken.address /* token */,
                100 /* minSpreadBps */,
                5 /* premiumBps */,
                { from: admin }
            );

            const min = await reserve.internalActivationMinSpreadBps(
                newToken.address
            );
            const premium = await reserve.internalPricePremiumBps(
                newToken.address
            );
            min.should.be.bignumber.eq(100);
            premium.should.be.bignumber.eq(5);
        });

        it("reject if not admin", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await truffleAssert.reverts(
                reserve.setInternalActivationConfig(
                    newToken.address /* token */,
                    100 /* minSpreadBps */,
                    5 /* premiumBps */,
                    { from: user }
                )
            );
        });

        it("reject if token is unlisted", async () => {
            const newToken = await deployToken();

            await truffleAssert.reverts(
                reserve.setInternalActivationConfig(
                    newToken.address /* token */,
                    100 /* minSpreadBps */,
                    5 /* premiumBps */,
                    { from: admin }
                )
            );
        });

        it("min spread <= 10%", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await truffleAssert.reverts(
                reserve.setInternalActivationConfig(
                    newToken.address /* token */,
                    11001 /* minSpreadBps */,
                    5 /* premiumBps */,
                    { from: admin }
                )
            );
        });

        it("premiumBps <= 5%", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            await truffleAssert.reverts(
                reserve.setInternalActivationConfig(
                    newToken.address /* token */,
                    100 /* minSpreadBps */,
                    501 /* premiumBps */,
                    { from: admin }
                )
            );
        });

        it("setting value emits an event", async () => {
            const newToken = await deployToken();
            await reserve.listToken(newToken.address, { from: admin });

            const res = await reserve.setInternalActivationConfig(
                newToken.address /* token */,
                100 /* minSpreadBps */,
                5 /* premiumBps */,
                { from: admin }
            );

            await truffleAssert.eventEmitted(
                res,
                "InternalActivationConfigUpdated",
                ev => {
                    return (
                        ev.token === newToken.address &&
                        ev.minSpreadBps.eq(100) &&
                        ev.premiumBps.eq(5)
                    );
                }
            );
        });
    });

    describe("#shouldUseInternalInventory", () => {
        const configureHighMinSpreadAndNoBalanceLimits = async () => {
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );
            // disable internal inventory limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                0 /* minBalance */,
                2 ** 255 /* maxBalance */,
                { from: operator }
            );
        };

        it("spread above activation level - use internal inventory", async () => {
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                web3.utils.toWei("1") /* minBalance */,
                web3.utils.toWei("1000") /* maxBalance */,
                { from: operator }
            );

            const tokenBalance = await token.balanceOf(reserve.address);
            tokenBalance.should.be.bignumber.eq(0);
            await token.transfer(
                reserve.address /* to */,
                web3.utils.toWei("500") /* value */,
                { from: bank }
            );

            // ETH -> Token: 1 -> 9
            // Token -> ETH: 10 -> 1
            const useInternal = await reserve.shouldUseInternalInventory(
                ETH_TOKEN_ADDRESS /* srcToken */,
                web3.utils.toWei("3") /* srcAmount */,
                token.address /* destToken */,
                web3.utils.toWei("300") /* destAmount */,
                new BigNumber(9).div(1) /* rateSrcDest */,
                new BigNumber(10).div(1) /* rateDestSrc */
            );

            useInternal.should.be.true;
        });

        it("spread below activation level - do not use internal inventory", async () => {
            // Minimum spread requirement: 10
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                5 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                web3.utils.toWei("1") /* minBalance */,
                web3.utils.toWei("10") /* maxBalance */,
                { from: operator }
            );

            // Fund reserve with 5 ETH (so it will not be a limiting factor)
            const ethBalance = await helper.getBalancePromise(reserve.address);
            ethBalance.should.be.bignumber.eq(0);
            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("5") /* amount */
            );

            // Fund reserve with 5 Tokens
            const tokenBalance = await token.balanceOf(reserve.address);
            tokenBalance.should.be.bignumber.eq(0);
            await token.transfer(
                reserve.address /* to */,
                web3.utils.toWei("5") /* value */,
                { from: bank }
            );

            // Spread of 2 BPS
            // ETH -> Token: 1 -> 9999
            // Token -> ETH: 10001 -> 1
            const useInternal = await reserve.shouldUseInternalInventory(
                ETH_TOKEN_ADDRESS /* srcToken */,
                web3.utils.toWei("3") /* srcAmount */,
                token.address /* destToken */,
                web3.utils.toWei("27") /* destAmount */,
                new BigNumber(9999).div(1) /* rateSrcDest */,
                new BigNumber(10001).div(1) /* rateDestSrc */
            );
            useInternal.should.be.false;
        });

        it("should use internal inventory with fees > 0", async () => {
            await reserve.setFee(25, { from: admin });

            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                web3.utils.toWei("1") /* minBalance */,
                web3.utils.toWei("1000") /* maxBalance */,
                { from: operator }
            );

            const tokenBalance = await token.balanceOf(reserve.address);
            tokenBalance.should.be.bignumber.eq(0);
            await token.transfer(
                reserve.address /* to */,
                web3.utils.toWei("500") /* value */,
                { from: bank }
            );

            // ETH -> Token: 1 -> 9
            // Token -> ETH: 10 -> 1
            const useInternal = await reserve.shouldUseInternalInventory(
                ETH_TOKEN_ADDRESS /* srcToken */,
                web3.utils.toWei("3") /* srcAmount */,
                token.address /* destToken */,
                web3.utils.toWei("27") /* destAmount */,
                new BigNumber(9).div(1).mul(0.9975) /* rateSrcDest */,
                new BigNumber(10).div(1).mul(0.9975) /* rateDestSrc */
            );

            useInternal.should.be.true;
        });

        it("fails if Token amount > MAX_QTY", async () => {
            await configureHighMinSpreadAndNoBalanceLimits();

            // ETH -> Token: 1 -> 9
            // Token -> ETH: 10 -> 1
            await truffleAssert.reverts(
                reserve.shouldUseInternalInventory(
                    ETH_TOKEN_ADDRESS /* srcToken */,
                    web3.utils.toWei("1") /* srcAmount */,
                    token.address /* destToken */,
                    KYBER_MAX_QTY /* destAmount */,
                    new BigNumber(9).div(1) /* rateSrcDest */,
                    new BigNumber(10).div(1) /* rateDestSrc */
                )
            );
        });

        it("fails if ETH amount > MAX_QTY", async () => {
            await configureHighMinSpreadAndNoBalanceLimits();

            // ETH -> Token: 10 -> 21
            // Token -> ETH: 20 -> 9
            await truffleAssert.reverts(
                reserve.shouldUseInternalInventory(
                    ETH_TOKEN_ADDRESS /* srcToken */,
                    KYBER_MAX_QTY /* srcAmount */,
                    token.address /* destToken */,
                    web3.utils.toWei("2") /* destAmount */,
                    new BigNumber(21).div(9) /* rateSrcDest */,
                    new BigNumber(20).div(9) /* rateDestSrc */
                )
            );
        });

        it("Token -> ETH: returns false if ETH balance too low", async () => {
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                web3.utils.toWei("1") /* minBalance */,
                web3.utils.toWei("10") /* maxBalance */,
                { from: operator }
            );

            // Fund reserve with 1 ETH
            const ethBalance = await helper.getBalancePromise(reserve.address);
            ethBalance.should.be.bignumber.eq(0);
            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("1") /* amount */
            );

            // Does not have enough ETH
            // ETH -> Token: 10 -> 21
            // Token -> ETH: 20 -> 9
            const useInternal = await reserve.shouldUseInternalInventory(
                token.address /* srcToken */,
                web3.utils.toWei("4") /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                web3.utils.toWei("2") /* destAmount */,
                new BigNumber(21).div(10) /* rateSrcDest */,
                new BigNumber(20).div(9) /* rateDestSrc */
            );

            useInternal.should.be.false;
        });

        it("Token -> ETH: returns false if token balance too high", async () => {
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                web3.utils.toWei("1") /* minBalance */,
                web3.utils.toWei("10") /* maxBalance */,
                { from: operator }
            );

            // Fund reserve with 5 ETH (so it will not be a limiting factor)
            const ethBalance = await helper.getBalancePromise(reserve.address);
            ethBalance.should.be.bignumber.eq(0);
            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("5") /* amount */
            );

            // Fund reserve with 5 Tokens
            const tokenBalance = await token.balanceOf(reserve.address);
            tokenBalance.should.be.bignumber.eq(0);
            await token.transfer(
                reserve.address /* to */,
                web3.utils.toWei("5") /* value */,
                { from: bank }
            );

            // Increasing ETH balance by 6 ETH takes it above maximum limit
            // ETH -> Token: 10 -> 21
            // Token -> ETH: 20 -> 9
            const useInternal = await reserve.shouldUseInternalInventory(
                token.address /* srcToken */,
                web3.utils.toWei("6") /* srcAmount */,
                ETH_TOKEN_ADDRESS /* destToken */,
                web3.utils.toWei("3") /* destAmount */,
                new BigNumber(21).div(10) /* rateSrcDest */,
                new BigNumber(20).div(9) /* rateDestSrc */
            );

            useInternal.should.be.false;
        });

        it("ETH -> Token: returns false if token balance too low", async () => {
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                web3.utils.toWei("1") /* minBalance */,
                web3.utils.toWei("10") /* maxBalance */,
                { from: operator }
            );

            // Fund reserve with 5 ETH (so it will not be a limiting factor)
            const ethBalance = await helper.getBalancePromise(reserve.address);
            ethBalance.should.be.bignumber.eq(0);
            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("5") /* amount */
            );

            // Fund reserve with 5 Tokens
            const tokenBalance = await token.balanceOf(reserve.address);
            tokenBalance.should.be.bignumber.eq(0);
            await token.transfer(
                reserve.address /* to */,
                web3.utils.toWei("5") /* value */,
                { from: bank }
            );

            // Reducing ETH balance by 4.5 ETH takes it below minimum limit
            // ETH -> Token: 10 -> 21
            // Token -> ETH: 20 -> 9
            const useInternal = await reserve.shouldUseInternalInventory(
                ETH_TOKEN_ADDRESS /* srcToken */,
                web3.utils.toWei("3") /* srcAmount */,
                token.address /* destToken */,
                web3.utils.toWei("4.5") /* destAmount */,
                new BigNumber(21).div(10) /* rateSrcDest */,
                new BigNumber(20).div(9) /* rateDestSrc */
            );

            useInternal.should.be.false;
        });

        it("returns false if there is arbitrage", async () => {
            // high minimum spread requirement
            await reserve.setInternalActivationConfig(
                token.address /* token */,
                1000 /* minSpreadBps */,
                0 /* premiumBps */,
                { from: admin }
            );

            // set limits
            await reserve.setInternalInventoryLimits(
                token.address /* token */,
                web3.utils.toWei("1") /* minBalance */,
                web3.utils.toWei("10") /* maxBalance */,
                { from: operator }
            );

            // Fund reserve with 5 ETH (so it will not be a limiting factor)
            const ethBalance = await helper.getBalancePromise(reserve.address);
            ethBalance.should.be.bignumber.eq(0);
            await helper.sendEtherWithPromise(
                bank /* sender */,
                reserve.address /* recv */,
                web3.utils.toWei("5") /* amount */
            );

            // Fund reserve with 5 Tokens
            const tokenBalance = await token.balanceOf(reserve.address);
            tokenBalance.should.be.bignumber.eq(0);
            await token.transfer(
                reserve.address /* to */,
                web3.utils.toWei("5") /* value */,
                { from: bank }
            );

            // Arbitrage rates!
            // ETH -> Token: 1 -> 11
            // Token -> ETH: 10 -> 1
            const useInternal = await reserve.shouldUseInternalInventory(
                ETH_TOKEN_ADDRESS /* srcToken */,
                web3.utils.toWei("3") /* srcAmount */,
                token.address /* destToken */,
                web3.utils.toWei("4.5") /* destAmount */,
                new BigNumber(11).div(1) /* rateSrcDest */,
                new BigNumber(10).div(1) /* rateDestSrc */
            );

            useInternal.should.be.false;
        });
    });

    describe("#calculateSpreadBps", () => {
        it("zero spread", async () => {
            const zeroSpread = await reserve.calculateSpreadBps(5, 5);

            zeroSpread.should.be.bignumber.eq(0);
        });

        it("ask == bid: zero spread", async () => {
            const zeroSpread = await reserve.calculateSpreadBps(5, 5);

            zeroSpread.should.be.bignumber.eq(0);
        });

        it("2 BPS spread", async () => {
            const spread = await reserve.calculateSpreadBps(10001, 9999);

            spread.should.be.bignumber.eq(2);
        });

        it("-10 BPS spread (internal arb)", async () => {
            const spread = await reserve.calculateSpreadBps(
                9995 /* ask */,
                10005 /* bid */
            );

            spread.should.be.bignumber.eq(-10);
        });
    });
});

async function dbg(...args) {
    if (DEBUG) console.log(...args);
}
