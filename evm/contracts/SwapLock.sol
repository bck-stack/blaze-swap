// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// One side of an atomic swap on an EVM chain (USDC on Base for the demo). The same sha256 hash locks the BCH side,
/// so whoever reveals the 32-byte secret to claim here also unlocks the other chain. Nobody else can move the tokens:
/// before the timeout they can only go to the recipient (with the secret), after it only back to the sender.
contract SwapLock {
    using SafeERC20 for IERC20;

    struct Lock {
        IERC20 token;
        address sender;
        address recipient;
        uint256 amount;
        bytes32 secretHash;
        uint64 timeout;
        bool settled;
    }

    mapping(bytes32 => Lock) public locks;

    event Locked(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 secretHash, uint64 timeout);
    event Claimed(bytes32 indexed id, bytes32 secret);
    event Refunded(bytes32 indexed id);

    error InvalidLock();
    error AlreadyExists();
    error NotFound();
    error AlreadySettled();
    error WrongSecret();
    error Expired();
    error NotExpired();

    /// Moves `amount` of `token` from the caller into the lock. The id is derived from all the terms, so the other side
    /// can recompute it and check the terms before it locks its own coins.
    function lock(IERC20 token, address recipient, uint256 amount, bytes32 secretHash, uint64 timeout) external returns (bytes32 id) {
        if (amount == 0 || recipient == address(0) || timeout <= block.timestamp) revert InvalidLock();
        id = lockId(token, msg.sender, recipient, amount, secretHash, timeout);
        if (locks[id].sender != address(0)) revert AlreadyExists();
        locks[id] = Lock(token, msg.sender, recipient, amount, secretHash, timeout, false);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Locked(id, msg.sender, recipient, address(token), amount, secretHash, timeout);
    }

    /// Anyone may submit the secret (a relayer can pay the gas); the tokens always go to the recipient.
    function claim(bytes32 id, bytes32 secret) external {
        Lock storage l = locks[id];
        if (l.sender == address(0)) revert NotFound();
        if (l.settled) revert AlreadySettled();
        if (block.timestamp >= l.timeout) revert Expired();
        if (sha256(abi.encodePacked(secret)) != l.secretHash) revert WrongSecret();
        l.settled = true;
        l.token.safeTransfer(l.recipient, l.amount);
        emit Claimed(id, secret);
    }

    /// After the timeout anyone may return the tokens to the sender.
    function refund(bytes32 id) external {
        Lock storage l = locks[id];
        if (l.sender == address(0)) revert NotFound();
        if (l.settled) revert AlreadySettled();
        if (block.timestamp < l.timeout) revert NotExpired();
        l.settled = true;
        l.token.safeTransfer(l.sender, l.amount);
        emit Refunded(id);
    }

    function lockId(IERC20 token, address sender, address recipient, uint256 amount, bytes32 secretHash, uint64 timeout) public pure returns (bytes32) {
        return keccak256(abi.encode(token, sender, recipient, amount, secretHash, timeout));
    }
}
