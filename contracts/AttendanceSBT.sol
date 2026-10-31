// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @dev ERC-5192 Minimal Soulbound (interfaceId 0xb45a3c0e)
interface IERC5192 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);
    function locked(uint256 tokenId) external view returns (bool);
}

/// @title Study Attendance SBT (SATT)
/// @notice PDF 11쪽: ERC-721 + 전송 잠금(ERC-5192). mint는 에스크로만, burn은 DAO만, 사용자 소각 불가.
contract AttendanceSBT is ERC721, IERC5192 {
    enum Kind { None, Round, Perfect }

    struct Info {
        Kind kind;
        uint16 round;        // 회차 (개근 배지는 0)
        uint16 attestCount;  // 그 회차에 받은 확인 수
        address study;       // 발행한 에스크로 주소
    }

    address public immutable admin; // 배포자: escrow, dao 주소를 각 1회 설정
    address public escrow;          // mint 권한
    address public dao;             // burn 권한 (플랜 B DAO 컨트랙트, 미설정이면 소각 불가)
    uint256 public nextId = 1;
    mapping(uint256 => Info) public info;

    error NotAdmin();
    error NotEscrow();
    error NotDao();
    error AlreadySet();
    error Soulbound();

    event EscrowSet(address escrow);
    event DaoSet(address dao);

    constructor() ERC721("Study Attendance SBT", "SATT") {
        admin = msg.sender;
    }

    function setEscrow(address e) external {
        if (msg.sender != admin) revert NotAdmin();
        if (escrow != address(0)) revert AlreadySet();
        escrow = e;
        emit EscrowSet(e);
    }

    function setDao(address d) external {
        if (msg.sender != admin) revert NotAdmin();
        if (dao != address(0)) revert AlreadySet();
        dao = d;
        emit DaoSet(d);
    }

    /// @notice 회차 출석 SBT 발행. 에스크로만 호출.
    function mintRound(address to, uint16 round, uint16 attestCount) external returns (uint256 id) {
        if (msg.sender != escrow) revert NotEscrow();
        id = nextId++;
        info[id] = Info(Kind.Round, round, attestCount, msg.sender);
        _mint(to, id);
        emit Locked(id);
    }

    /// @notice 개근 배지 발행. 에스크로만 호출.
    function mintPerfect(address to) external returns (uint256 id) {
        if (msg.sender != escrow) revert NotEscrow();
        id = nextId++;
        info[id] = Info(Kind.Perfect, 0, 0, msg.sender);
        _mint(to, id);
        emit Locked(id);
    }

    /// @notice 허위 증빙 확정 시 DAO 의결로만 소각.
    function burn(uint256 id) external {
        if (msg.sender != dao) revert NotDao();
        _burn(id);
        delete info[id];
    }

    // ---- ERC-5192 ----
    function locked(uint256 id) external view returns (bool) {
        _requireOwned(id);
        return true;
    }

    function supportsInterface(bytes4 i) public view override returns (bool) {
        return i == type(IERC5192).interfaceId || super.supportsInterface(i);
    }

    // ---- 전송·승인 차단 ----
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    // ---- 메타데이터 (온체인 JSON) ----
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        Info memory x = info[id];
        bool perfect = x.kind == Kind.Perfect;
        string memory name_ = perfect
            ? "Perfect Attendance"
            : string.concat("Attendance Round ", Strings.toString(x.round));
        return string.concat(
            'data:application/json;utf8,{"name":"', name_,
            '","description":"Study attendance record (soulbound)","attributes":[',
            '{"trait_type":"kind","value":"', perfect ? "perfect" : "round", '"},',
            '{"trait_type":"round","value":', Strings.toString(x.round), '},',
            '{"trait_type":"attestCount","value":', Strings.toString(x.attestCount), '}]}'
        );
    }
}
