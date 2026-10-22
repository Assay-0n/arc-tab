// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Tab} from "../Tab.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ---------------------------------------------------------------------------
// Minimal 6-decimal MockERC20 — only what Tab needs.
// ---------------------------------------------------------------------------
contract MockERC20 {
    string public name;
    string public symbol;
    uint8  public decimals;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _sym, uint8 _dec) {
        name     = _name;
        symbol   = _sym;
        decimals = _dec;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amount, "allowance");
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

// ---------------------------------------------------------------------------
// Main test contract
// ---------------------------------------------------------------------------
contract TabTest is Test {

    // ---- constants --------------------------------------------------------
    uint256 internal constant PAYER_PK  = 0xA11CE;
    uint256 internal constant PAYEE_PK  = 0xB0B;
    uint256 internal constant RANDO_PK  = 0xDEAD;

    uint128 internal constant DEPOSIT   = 1_000e6;  // 1 000 USDC (6 dec)
    uint64  internal constant ONE_DAY   = 1 days;

    // ---- state ------------------------------------------------------------
    MockERC20 internal usdc;
    Tab       internal tab;

    address internal payer;
    address internal payee;
    address internal rando;

    uint64  internal expiry;   // set in setUp

    // ---- setUp ------------------------------------------------------------
    function setUp() public {
        payer = vm.addr(PAYER_PK);
        payee = vm.addr(PAYEE_PK);
        rando = vm.addr(RANDO_PK);

        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        tab  = new Tab(address(usdc));

        // Fund payer and pre-approve
        usdc.mint(payer, 100_000e6);
        vm.prank(payer);
        usdc.approve(address(tab), type(uint256).max);

        expiry = uint64(block.timestamp + ONE_DAY);
    }

    // -----------------------------------------------------------------------
    // Helper: sign a voucher with the given private key
    // -----------------------------------------------------------------------
    function _sign(uint256 pk, uint256 tabId, uint128 cumulative)
        internal view returns (bytes memory sig)
    {
        bytes32 digest = tab.voucherDigest(tabId, cumulative);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    // -----------------------------------------------------------------------
    // Helper: open a fresh tab and return its id
    // -----------------------------------------------------------------------
    function _open(uint128 amount, uint64 exp) internal returns (uint256 tabId) {
        vm.prank(payer);
        tabId = tab.open(payee, amount, exp);
    }

    // =======================================================================
    // 1. open / topUp / extend — happy paths
    // =======================================================================

    function test_Open_HappyPath() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        assertEq(tabId, 0,                        "first tabId should be 0");
        assertEq(tab.nextTabId(), 1,               "nextTabId increments");

        (
            address tPayer,
            address tPayee,
            uint128 deposit,
            uint128 settled,
            uint64  tExpiry,
            bool    closed
        ) = tab.tabs(tabId);

        assertEq(tPayer,   payer,   "payer stored");
        assertEq(tPayee,   payee,   "payee stored");
        assertEq(deposit,  DEPOSIT, "deposit stored");
        assertEq(settled,  0,       "settled starts at 0");
        assertEq(tExpiry,  expiry,  "expiry stored");
        assertFalse(closed,         "not closed");

        // USDC moved from payer to tab
        assertEq(usdc.balanceOf(address(tab)), DEPOSIT);
        assertEq(usdc.balanceOf(payer),        100_000e6 - DEPOSIT);
    }

    function test_Open_EmitsTabOpened() public {
        vm.prank(payer);
        vm.expectEmit(true, true, true, true, address(tab));
        emit Tab.TabOpened(0, payer, payee, DEPOSIT, expiry);
        tab.open(payee, DEPOSIT, expiry);
    }

    function test_Open_Revert_ZeroAddress_Payee() public {
        vm.prank(payer);
        vm.expectRevert(Tab.ZeroAddress.selector);
        tab.open(address(0), DEPOSIT, expiry);
    }

    function test_Open_Revert_SelfTab() public {
        vm.prank(payer);
        vm.expectRevert(Tab.SelfTab.selector);
        tab.open(payer, DEPOSIT, expiry);
    }

    function test_Open_Revert_ZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(Tab.ZeroAmount.selector);
        tab.open(payee, 0, expiry);
    }

    function test_Open_Revert_Expired_ExpiryInPast() public {
        vm.prank(payer);
        vm.expectRevert(Tab.Expired.selector);
        tab.open(payee, DEPOSIT, uint64(block.timestamp));  // == block.timestamp → Expired
    }

    function test_Open_Revert_ZeroAddress_USDC() public {
        vm.expectRevert(Tab.ZeroAddress.selector);
        new Tab(address(0));
    }

    function test_TopUp_HappyPath() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        uint128 extra = 500e6;
        vm.prank(payer);
        tab.topUp(tabId, extra);

        (, , uint128 deposit, , ,) = tab.tabs(tabId);
        assertEq(deposit, DEPOSIT + extra, "deposit updated");
        assertEq(usdc.balanceOf(address(tab)), DEPOSIT + extra, "usdc balance updated");
    }

    function test_TopUp_EmitsToppedUp() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        uint128 extra = 200e6;

        vm.prank(payer);
        vm.expectEmit(true, false, false, true, address(tab));
        emit Tab.ToppedUp(tabId, extra, DEPOSIT + extra);
        tab.topUp(tabId, extra);
    }

    function test_TopUp_Revert_NotPayer() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.prank(rando);
        vm.expectRevert(Tab.NotPayer.selector);
        tab.topUp(tabId, 100e6);
    }

    function test_TopUp_Revert_ZeroAmount() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.prank(payer);
        vm.expectRevert(Tab.ZeroAmount.selector);
        tab.topUp(tabId, 0);
    }

    function test_TopUp_Revert_AfterExpiry() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.warp(expiry + 1);
        vm.prank(payer);
        vm.expectRevert(Tab.Expired.selector);
        tab.topUp(tabId, 100e6);
    }

    function test_Extend_HappyPath() public {
        uint256 tabId    = _open(DEPOSIT, expiry);
        uint64  newExpiry = expiry + ONE_DAY;

        vm.prank(payer);
        tab.extend(tabId, newExpiry);

        (, , , , uint64 tExpiry,) = tab.tabs(tabId);
        assertEq(tExpiry, newExpiry, "expiry updated");
    }

    function test_Extend_EmitsExtended() public {
        uint256 tabId    = _open(DEPOSIT, expiry);
        uint64  newExpiry = expiry + ONE_DAY;

        vm.prank(payer);
        vm.expectEmit(true, false, false, true, address(tab));
        emit Tab.Extended(tabId, newExpiry);
        tab.extend(tabId, newExpiry);
    }

    function test_Extend_Revert_NotPayer() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.prank(rando);
        vm.expectRevert(Tab.NotPayer.selector);
        tab.extend(tabId, expiry + ONE_DAY);
    }

    function test_Extend_Revert_InvalidExpiry_NotIncreasing() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.prank(payer);
        vm.expectRevert(Tab.InvalidExpiry.selector);
        tab.extend(tabId, expiry);   // same expiry → InvalidExpiry
    }

    // =======================================================================
    // 2. settle twice — only deltas are paid
    // =======================================================================

    function test_Settle_TwicePaysDelta() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        uint128 first  = 300e6;
        uint128 second = 700e6;

        // First settle
        bytes memory sig1 = _sign(PAYER_PK, tabId, first);
        vm.prank(payee);
        tab.settle(tabId, first, sig1);

        assertEq(usdc.balanceOf(payee), first, "payee gets first delta");

        // Second settle
        bytes memory sig2 = _sign(PAYER_PK, tabId, second);
        vm.prank(payee);
        tab.settle(tabId, second, sig2);

        assertEq(usdc.balanceOf(payee), second, "payee gets total cumulative");
        assertEq(usdc.balanceOf(address(tab)), DEPOSIT - second, "tab holds remainder");
    }

    function test_Settle_EmitsSettled() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        uint128 cum   = 400e6;
        bytes memory sig = _sign(PAYER_PK, tabId, cum);

        vm.prank(payee);
        vm.expectEmit(true, false, false, true, address(tab));
        emit Tab.Settled(tabId, cum, cum);
        tab.settle(tabId, cum, sig);
    }

    // =======================================================================
    // 3. replayed / lower voucher reverts
    // =======================================================================

    function test_Settle_Revert_ReplayedVoucher() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        uint128 cum   = 300e6;
        bytes memory sig = _sign(PAYER_PK, tabId, cum);

        vm.prank(payee);
        tab.settle(tabId, cum, sig);

        // Replaying the same voucher: settled >= cumulative → InvalidCumulative
        vm.prank(payee);
        vm.expectRevert(Tab.InvalidCumulative.selector);
        tab.settle(tabId, cum, sig);
    }

    function test_Settle_Revert_LowerVoucher() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        bytes memory sig2 = _sign(PAYER_PK, tabId, 500e6);
        vm.prank(payee);
        tab.settle(tabId, 500e6, sig2);

        // Try to settle with a lower value
        bytes memory sig1 = _sign(PAYER_PK, tabId, 200e6);
        vm.prank(payee);
        vm.expectRevert(Tab.InvalidCumulative.selector);
        tab.settle(tabId, 200e6, sig1);
    }

    // =======================================================================
    // 4. wrong signer reverts
    // =======================================================================

    function test_Settle_Revert_BadSignature_WrongSigner() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        uint128 cum   = 200e6;

        // Signed by rando instead of payer
        bytes memory badSig = _sign(RANDO_PK, tabId, cum);
        vm.prank(payee);
        vm.expectRevert(Tab.BadSignature.selector);
        tab.settle(tabId, cum, badSig);
    }

    // =======================================================================
    // 5. cross-tab replay — voucher for another tabId reverts
    // =======================================================================

    function test_Settle_Revert_CrossTabReplay() public {
        // Open two tabs
        uint256 tabId0 = _open(DEPOSIT, expiry);

        usdc.mint(payer, DEPOSIT);
        uint256 tabId1 = _open(DEPOSIT, expiry);

        uint128 cum = 200e6;

        // Sign a voucher for tabId1, try to use it on tabId0
        bytes memory sigForTab1 = _sign(PAYER_PK, tabId1, cum);

        vm.prank(payee);
        vm.expectRevert(Tab.BadSignature.selector);
        tab.settle(tabId0, cum, sigForTab1);
    }

    // =======================================================================
    // 6. settle after expiry reverts
    // =======================================================================

    function test_Settle_Revert_AfterExpiry() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.warp(expiry + 1);

        bytes memory sig = _sign(PAYER_PK, tabId, 100e6);
        vm.prank(payee);
        vm.expectRevert(Tab.Expired.selector);
        tab.settle(tabId, 100e6, sig);
    }

    // =======================================================================
    // 7. reclaim before expiry reverts
    // =======================================================================

    function test_Reclaim_Revert_BeforeExpiry() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.prank(payer);
        vm.expectRevert(Tab.NotExpired.selector);
        tab.reclaim(tabId);
    }

    function test_Reclaim_Revert_NotPayer() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.warp(expiry + 1);
        vm.prank(rando);
        vm.expectRevert(Tab.NotPayer.selector);
        tab.reclaim(tabId);
    }

    // =======================================================================
    // 8. reclaim after expiry — refunds deposit minus settled
    // =======================================================================

    function test_Reclaim_AfterExpiry_FullRefund() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        vm.warp(expiry + 1);

        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(payer);
        tab.reclaim(tabId);

        assertEq(usdc.balanceOf(payer), payerBefore + DEPOSIT, "full refund");
        assertEq(usdc.balanceOf(address(tab)), 0,              "tab drained");

        (, , , , , bool closed) = tab.tabs(tabId);
        assertTrue(closed, "tab is closed");
    }

    function test_Reclaim_AfterExpiry_PartialRefund() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        // Settle 300 USDC before expiry
        uint128 cum = 300e6;
        bytes memory sig = _sign(PAYER_PK, tabId, cum);
        vm.prank(payee);
        tab.settle(tabId, cum, sig);

        vm.warp(expiry + 1);

        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(payer);
        tab.reclaim(tabId);

        uint128 expectedRefund = DEPOSIT - cum;
        assertEq(usdc.balanceOf(payer), payerBefore + expectedRefund, "partial refund correct");
        assertEq(usdc.balanceOf(payee), cum,                          "payee kept its payment");
    }

    function test_Reclaim_EmitsClosed() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.warp(expiry + 1);

        vm.prank(payer);
        vm.expectEmit(true, false, false, true, address(tab));
        emit Tab.Closed(tabId, DEPOSIT);
        tab.reclaim(tabId);
    }

    function test_Reclaim_Revert_AlreadyClosed() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        vm.warp(expiry + 1);
        vm.prank(payer);
        tab.reclaim(tabId);

        vm.prank(payer);
        vm.expectRevert(Tab.TabClosed.selector);
        tab.reclaim(tabId);
    }

    // =======================================================================
    // 9. settleAndClose — pays payee and refunds payer in one call
    // =======================================================================

    function test_SettleAndClose_HappyPath() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        uint128 cum    = 600e6;
        uint128 refund = DEPOSIT - cum;

        bytes memory sig = _sign(PAYER_PK, tabId, cum);

        vm.prank(payee);
        tab.settleAndClose(tabId, cum, sig);

        assertEq(usdc.balanceOf(payee),        cum,    "payee paid correctly");
        assertEq(usdc.balanceOf(payer),        100_000e6 - DEPOSIT + refund, "payer refunded correctly");
        assertEq(usdc.balanceOf(address(tab)), 0,      "tab is empty");

        (, , , , , bool closed) = tab.tabs(tabId);
        assertTrue(closed, "tab is closed");
    }

    function test_SettleAndClose_EmitsSettledAndClosed() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        uint128 cum   = 400e6;
        bytes memory sig = _sign(PAYER_PK, tabId, cum);

        vm.prank(payee);
        vm.expectEmit(true, false, false, true, address(tab));
        emit Tab.Settled(tabId, cum, cum);
        vm.expectEmit(true, false, false, true, address(tab));
        emit Tab.Closed(tabId, DEPOSIT - cum);
        tab.settleAndClose(tabId, cum, sig);
    }

    function test_SettleAndClose_AfterPartialSettle() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        // Settle 300 first
        uint128 cum1 = 300e6;
        bytes memory sig1 = _sign(PAYER_PK, tabId, cum1);
        vm.prank(payee);
        tab.settle(tabId, cum1, sig1);

        // settleAndClose for 700 (cumulative total)
        uint128 cum2 = 700e6;
        bytes memory sig2 = _sign(PAYER_PK, tabId, cum2);
        vm.prank(payee);
        tab.settleAndClose(tabId, cum2, sig2);

        assertEq(usdc.balanceOf(payee), cum2,                              "payee total correct");
        assertEq(usdc.balanceOf(payer), 100_000e6 - DEPOSIT + (DEPOSIT - cum2), "payer refund correct");
        assertEq(usdc.balanceOf(address(tab)), 0,                          "tab empty");
    }

    function test_SettleAndClose_ZeroCumulative_AllRefundedToPayer() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        // cumulative == 0 → payee gets nothing, payer gets all back
        bytes memory sig = _sign(PAYER_PK, tabId, 0);
        vm.prank(payee);
        tab.settleAndClose(tabId, 0, sig);

        assertEq(usdc.balanceOf(payee), 0,                         "payee gets nothing");
        assertEq(usdc.balanceOf(payer), 100_000e6 - DEPOSIT + DEPOSIT, "payer gets full deposit back");
    }

    // =======================================================================
    // 10. cumulative > deposit reverts on both settle and settleAndClose
    // =======================================================================

    function test_Settle_Revert_CumulativeExceedsDeposit() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        uint128 overDeposit = DEPOSIT + 1;
        bytes memory sig = _sign(PAYER_PK, tabId, overDeposit);

        vm.prank(payee);
        vm.expectRevert(Tab.InvalidCumulative.selector);
        tab.settle(tabId, overDeposit, sig);
    }

    function test_SettleAndClose_Revert_CumulativeExceedsDeposit() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        uint128 overDeposit = DEPOSIT + 1;
        bytes memory sig = _sign(PAYER_PK, tabId, overDeposit);

        vm.prank(payee);
        vm.expectRevert(Tab.InvalidCumulative.selector);
        tab.settleAndClose(tabId, overDeposit, sig);
    }

    // =======================================================================
    // 11. nobody but the payee can call settleAndClose
    // =======================================================================

    function test_SettleAndClose_Revert_NotPayee_Payer() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        uint128 cum   = 500e6;
        bytes memory sig = _sign(PAYER_PK, tabId, cum);

        vm.prank(payer);  // payer tries → NotPayee
        vm.expectRevert(Tab.NotPayee.selector);
        tab.settleAndClose(tabId, cum, sig);
    }

    function test_SettleAndClose_Revert_NotPayee_Rando() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        uint128 cum   = 500e6;
        bytes memory sig = _sign(PAYER_PK, tabId, cum);

        vm.prank(rando);
        vm.expectRevert(Tab.NotPayee.selector);
        tab.settleAndClose(tabId, cum, sig);
    }

    // =======================================================================
    // 12. Fuzz: for random increasing cumulative sequences the balances
    //     after settleAndClose always sum to the original deposit.
    // =======================================================================

    function testFuzz_SettleAndClose_BalancesConserved(
        uint128 cum1,
        uint128 cum2
    ) public {
        // Bound: 0 <= cum1 < cum2 <= DEPOSIT
        cum1 = uint128(bound(uint256(cum1), 0, uint256(DEPOSIT) - 1));
        cum2 = uint128(bound(uint256(cum2), uint256(cum1) + 1, uint256(DEPOSIT)));

        uint256 tabId = _open(DEPOSIT, expiry);

        // First partial settle with cum1 (skip if zero — settled == 0 reverts)
        if (cum1 > 0) {
            bytes memory sig1 = _sign(PAYER_PK, tabId, cum1);
            vm.prank(payee);
            tab.settle(tabId, cum1, sig1);
        }

        // settleAndClose at cum2
        bytes memory sig2 = _sign(PAYER_PK, tabId, cum2);
        vm.prank(payee);
        tab.settleAndClose(tabId, cum2, sig2);

        uint256 payeeBalance = usdc.balanceOf(payee);
        uint256 payerBalance = usdc.balanceOf(payer);

        // payee balance == cum2 (total paid to payee)
        assertEq(payeeBalance, cum2, "payee balance equals cumulative");

        // payer got back deposit - cum2
        // payer started with 100_000e6, deposited DEPOSIT, so now has 100_000e6 - DEPOSIT + (DEPOSIT - cum2)
        uint256 expectedPayer = uint256(100_000e6) - uint256(DEPOSIT) + uint256(DEPOSIT - cum2);
        assertEq(payerBalance, expectedPayer, "payer balance correct");

        // Conservation: payee + refund == DEPOSIT
        assertEq(payeeBalance + (uint256(DEPOSIT) - uint256(cum2)), uint256(DEPOSIT), "conservation law holds");
    }

    function testFuzz_Settle_DeltasAlwaysSumToCumulative(
        uint128[3] memory cumulatives
    ) public {
        // Sort and bound three increasing cumulative values
        uint256 c0 = bound(uint256(cumulatives[0]), 1,   uint256(DEPOSIT) / 3);
        uint256 c1 = bound(uint256(cumulatives[1]), c0 + 1, uint256(DEPOSIT) * 2 / 3);
        uint256 c2 = bound(uint256(cumulatives[2]), c1 + 1, uint256(DEPOSIT));

        uint256 tabId = _open(DEPOSIT, expiry);

        vm.prank(payee); tab.settle(tabId, uint128(c0), _sign(PAYER_PK, tabId, uint128(c0)));
        vm.prank(payee); tab.settle(tabId, uint128(c1), _sign(PAYER_PK, tabId, uint128(c1)));
        vm.prank(payee); tab.settle(tabId, uint128(c2), _sign(PAYER_PK, tabId, uint128(c2)));

        assertEq(usdc.balanceOf(payee), c2,                    "payee total == last cumulative");
        assertEq(usdc.balanceOf(address(tab)), DEPOSIT - c2,   "tab holds remainder");
    }

    // =======================================================================
    // Edge: settle/topUp/extend on a closed tab reverts
    // =======================================================================

    function test_Settle_Revert_TabClosed() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        bytes memory sig = _sign(PAYER_PK, tabId, DEPOSIT);
        vm.prank(payee);
        tab.settleAndClose(tabId, DEPOSIT, sig);

        bytes memory sig2 = _sign(PAYER_PK, tabId, DEPOSIT);
        vm.prank(payee);
        vm.expectRevert(Tab.TabClosed.selector);
        tab.settle(tabId, DEPOSIT, sig2);
    }

    function test_TopUp_Revert_TabClosed() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        bytes memory sig = _sign(PAYER_PK, tabId, DEPOSIT);
        vm.prank(payee);
        tab.settleAndClose(tabId, DEPOSIT, sig);

        vm.prank(payer);
        vm.expectRevert(Tab.TabClosed.selector);
        tab.topUp(tabId, 100e6);
    }

    function test_Extend_Revert_TabClosed() public {
        uint256 tabId = _open(DEPOSIT, expiry);

        bytes memory sig = _sign(PAYER_PK, tabId, DEPOSIT);
        vm.prank(payee);
        tab.settleAndClose(tabId, DEPOSIT, sig);

        vm.prank(payer);
        vm.expectRevert(Tab.TabClosed.selector);
        tab.extend(tabId, expiry + ONE_DAY);
    }

    // =======================================================================
    // remaining() view
    // =======================================================================

    function test_Remaining_AfterSettle() public {
        uint256 tabId = _open(DEPOSIT, expiry);
        uint128 cum   = 300e6;

        assertEq(tab.remaining(tabId), DEPOSIT, "before settle: full deposit");

        bytes memory sig = _sign(PAYER_PK, tabId, cum);
        vm.prank(payee);
        tab.settle(tabId, cum, sig);

        assertEq(tab.remaining(tabId), DEPOSIT - cum, "after settle: deposit minus settled");
    }
}
