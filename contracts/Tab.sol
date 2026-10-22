// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Tab is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct TabInfo {
        address payer;
        address payee;
        uint128 deposit;
        uint128 settled;
        uint64 expiry;
        bool closed;
    }

    event TabOpened(uint256 indexed tabId, address indexed payer, address indexed payee, uint128 amount, uint64 expiry);
    event ToppedUp(uint256 indexed tabId, uint128 amount, uint128 newDeposit);
    event Extended(uint256 indexed tabId, uint64 newExpiry);
    event Settled(uint256 indexed tabId, uint128 cumulative, uint128 paid);
    event Closed(uint256 indexed tabId, uint128 refund);

    error ZeroAddress();
    error SelfTab();
    error ZeroAmount();
    error Expired();
    error NotExpired();
    error TabClosed();
    error NotPayer();
    error NotPayee();
    error InvalidExpiry();
    error InvalidCumulative();
    error BadSignature();

    bytes32 private constant VOUCHER_TYPEHASH = keccak256("Voucher(uint256 tabId,uint128 cumulative)");

    IERC20 public immutable usdc;
    mapping(uint256 => TabInfo) public tabs;
    uint256 public nextTabId;

    constructor(address _usdc) EIP712("Tab", "1") {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    function open(address payee, uint128 amount, uint64 expiry) external nonReentrant returns (uint256 tabId) {
        if (payee == address(0)) revert ZeroAddress();
        if (payee == msg.sender) revert SelfTab();
        if (amount == 0) revert ZeroAmount();
        if (expiry <= block.timestamp) revert Expired();

        tabId = nextTabId++;
        tabs[tabId] = TabInfo({
            payer: msg.sender,
            payee: payee,
            deposit: amount,
            settled: 0,
            expiry: expiry,
            closed: false
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit TabOpened(tabId, msg.sender, payee, amount, expiry);
    }

    function topUp(uint256 tabId, uint128 amount) external nonReentrant {
        TabInfo storage tab = tabs[tabId];
        if (tab.payer != msg.sender) revert NotPayer();
        if (tab.closed) revert TabClosed();
        if (block.timestamp > tab.expiry) revert Expired();
        if (amount == 0) revert ZeroAmount();

        tab.deposit += amount;

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit ToppedUp(tabId, amount, tab.deposit);
    }

    function extend(uint256 tabId, uint64 newExpiry) external {
        TabInfo storage tab = tabs[tabId];
        if (tab.payer != msg.sender) revert NotPayer();
        if (tab.closed) revert TabClosed();
        if (newExpiry <= tab.expiry) revert InvalidExpiry();

        tab.expiry = newExpiry;

        emit Extended(tabId, newExpiry);
    }

    function settle(uint256 tabId, uint128 cumulative, bytes calldata signature) external nonReentrant {
        TabInfo storage tab = tabs[tabId];
        if (tab.closed) revert TabClosed();
        if (block.timestamp > tab.expiry) revert Expired();

        _validateVoucher(tab, tabId, cumulative, signature);

        if (tab.settled >= cumulative) revert InvalidCumulative();
        if (cumulative > tab.deposit) revert InvalidCumulative();

        uint128 paid = cumulative - tab.settled;
        tab.settled = cumulative;

        usdc.safeTransfer(tab.payee, paid);

        emit Settled(tabId, cumulative, paid);
    }

    function settleAndClose(uint256 tabId, uint128 cumulative, bytes calldata signature) external nonReentrant {
        TabInfo storage tab = tabs[tabId];
        if (msg.sender != tab.payee) revert NotPayee();
        if (tab.closed) revert TabClosed();

        _validateVoucher(tab, tabId, cumulative, signature);

        if (cumulative > tab.deposit) revert InvalidCumulative();
        if (cumulative < tab.settled) revert InvalidCumulative();

        uint128 paid = cumulative - tab.settled;
        uint128 refund = tab.deposit - cumulative;

        tab.settled = cumulative;
        tab.closed = true;

        if (paid > 0) {
            usdc.safeTransfer(tab.payee, paid);
            emit Settled(tabId, cumulative, paid);
        }

        if (refund > 0) {
            usdc.safeTransfer(tab.payer, refund);
        }

        emit Closed(tabId, refund);
    }

    function reclaim(uint256 tabId) external nonReentrant {
        TabInfo storage tab = tabs[tabId];
        if (tab.payer != msg.sender) revert NotPayer();
        if (block.timestamp <= tab.expiry) revert NotExpired();
        if (tab.closed) revert TabClosed();

        uint128 refund = tab.deposit - tab.settled;
        tab.closed = true;

        if (refund > 0) {
            usdc.safeTransfer(msg.sender, refund);
        }

        emit Closed(tabId, refund);
    }

    function voucherDigest(uint256 tabId, uint128 cumulative) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, tabId, cumulative));
        return _hashTypedDataV4(structHash);
    }

    function remaining(uint256 tabId) public view returns (uint128) {
        TabInfo storage tab = tabs[tabId];
        return tab.deposit - tab.settled;
    }

    function _validateVoucher(TabInfo storage tab, uint256 tabId, uint128 cumulative, bytes calldata signature) internal view {
        bytes32 digest = voucherDigest(tabId, cumulative);
        address signer = ECDSA.recover(digest, signature);
        if (signer == address(0) || signer != tab.payer) revert BadSignature();
    }
}
