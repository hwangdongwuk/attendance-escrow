// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Study Deposit Token (SDT) - 테스트넷 시연용 모의 스테이블코인
/// @notice PDF 11쪽 토큰 정책: 기존 ERC-20 사용, 에스크로는 새로 발행하지 않는다.
///         실서비스에서는 이 컨트랙트 대신 실제 스테이블코인 주소를 에스크로에 넣는다.
contract MockSDT is ERC20 {
    uint256 public constant FAUCET_CAP = 1_000_000e18; // 1회 최대 지급

    error FaucetCapExceeded();

    constructor() ERC20("Study Deposit Token", "SDT") {}

    /// @notice 시연용 배분 함수(PDF 22쪽 "시연용 테스트 SDT 배분"). 누구나 호출 가능.
    function faucet(uint256 amount) external {
        if (amount > FAUCET_CAP) revert FaucetCapExceeded();
        _mint(msg.sender, amount);
    }
}
