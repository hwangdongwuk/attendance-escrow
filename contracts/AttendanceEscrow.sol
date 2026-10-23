// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AttendanceEscrow (골격)
/// @notice 출석 보증금 에스크로. 필수 7 기능은 구상안 v0.2 기준으로 구현 예정.
contract AttendanceEscrow {
    uint256 public immutable depositAmount;

    constructor(uint256 _depositAmount) {
        depositAmount = _depositAmount;
    }
}