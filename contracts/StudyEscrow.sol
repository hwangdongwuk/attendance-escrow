// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAttendanceSBT {
    function mintRound(address to, uint16 round, uint16 attestCount) external returns (uint256);
    function mintPerfect(address to) external returns (uint256);
}

/// @title StudyEscrow - 스터디 출석 보증금 에스크로 (스터디 1개 = 컨트랙트 1개)
/// @notice 4조 중간과제 PDF(2026-10-30) 정책 기준 플랜 A 범위.
///   - createStudy() = 생성자(배포). 멤버·규칙은 배포 시 확정.
///   - 멤버는 등록 순서 index로 관리(지갑 교체는 플랜 B, 구조만 준비).
///   - 시간 정책은 초 단위 파라미터(시연 시 분 단위로 설정 가능).
///   - 분배금은 각자 withdraw()로 인출(pull 패턴, CEI).
///   - 공결(setExcuse)은 임시로 admin이 설정. 플랜 B에서 DAO propose/vote로 대체.
///   - 이의 제기·DAO·중도 탈퇴·지갑 교체는 플랜 B.
contract StudyEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum StudyState { Created, Active, Cancelled, Finalized }
    enum Attendance { Pending, Present, Late, Absent, Excused }

    struct Config {
        uint256 perRound;      // 회차 몫 (예: 5,000 SDT)
        uint16 rounds;         // 총 회차 (예: 7)
        uint16 threshold;      // 출석 인정 확인 수 (예: 3, 본인 제외 N-1명 중)
        uint32 depositWindow;  // 배포 후 예치 기한 (예: 3일)
        uint32 submitWindow;   // 회차 시작 → 증빙 제출 마감 (예: 7일)
        uint32 lateWindow;     // 증빙 마감 → 지각 제출 마감 (예: 1일)
        uint32 attestWindow;   // 지각 마감 → 상호 확인 마감 (예: 1일)
    }

    struct Round {
        uint64 openedAt;
        uint64 proofDeadline;
        uint64 lateDeadline;
        uint64 attestDeadline;
        bool settled;
        uint16 presentCount;
        uint256 pool;          // 정산 시 분배 대상 금액(결석·지각 몰수 + 이월)
    }

    struct MemberRound {
        bytes32 proofHash;
        uint64 proofAt;
        bool late;
        bool excused;
        uint16 attestCount;
        Attendance status;
    }

    IERC20 public immutable token;
    IAttendanceSBT public immutable sbt;
    address public immutable admin; // 임시 공결 설정 권한 [플랜 B: DAO로 대체]
    Config public config;
    StudyState public state;
    uint64 public createdAt;
    uint64 public startedAt;
    uint16 public currentRound;     // 마지막으로 연 회차 번호 (0 = 아직 없음)
    uint16 public depositedCount;

    address[] private _members;
    mapping(address => uint256) private _memberIdx1; // index + 1 (0 = 비멤버)
    mapping(address => bool) public deposited;
    mapping(uint16 => Round) private _rounds;
    mapping(uint16 => mapping(address => MemberRound)) private _mr;
    mapping(uint16 => mapping(address => mapping(address => bool))) public hasAttested;
    mapping(uint16 => mapping(address => address[])) private _attesters;

    mapping(address => uint256) public balanceOf;  // 인출 가능 잔액
    mapping(address => uint256) public lockedOf;   // 아직 정산되지 않은 보증금
    mapping(address => uint16) public attendCount; // 출석(Present) 횟수, 개근 판정용
    uint256 public carryPool;      // 전원 결석 시 다음 회차로 이월
    uint256 public remainderPool;  // 균등 분배 후 나머지 → 최종 정산 시 개근자

    // ---- events (PDF 14쪽 로그 정책 + 운영 이벤트) ----
    event Deposited(address indexed member, uint256 amount);
    event StudyStarted(uint64 at);
    event StudyCancelled(uint64 at);
    event Refunded(address indexed member, uint256 amount);
    event RoundOpened(uint16 indexed round, uint64 proofDeadline, uint64 lateDeadline, uint64 attestDeadline);
    event ProofSubmitted(uint16 indexed round, address indexed member, bytes32 proofHash, bool late);
    event Attested(uint16 indexed round, address indexed member, address indexed attester, uint16 count);
    event ExcuseSet(uint16 indexed round, address indexed member);
    event AttendanceJudged(uint16 indexed round, address indexed member, Attendance status, uint256 refund);
    event RoundSettled(uint16 indexed round, uint16 presentCount, uint256 pool, uint256 sharePerPresent);
    event Distributed(uint16 indexed round, address indexed member, uint256 amount);
    event StudyFinalized(uint16 perfectCount, uint256 leftover);
    event Withdrawn(address indexed member, uint256 amount);

    // ---- errors ----
    error InvalidConfig();
    error InvalidMembers();
    error NotMember();
    error WrongState();
    error AlreadyDeposited();
    error DepositWindowClosed();
    error DepositWindowOpen();
    error RoundNotOpen();
    error PreviousRoundNotSettled();
    error AllRoundsDone();
    error ProofAlreadySubmitted();
    error ProofWindowClosed();
    error EmptyHash();
    error SelfAttest();
    error NoProof();
    error AlreadyAttested();
    error AttestWindowClosed();
    error TooEarlyToSettle();
    error AlreadySettled();
    error NotAdmin();
    error InvalidRound();
    error NotAllSettled();
    error NothingToWithdraw();

    constructor(IERC20 token_, IAttendanceSBT sbt_, address[] memory members_, Config memory cfg) {
        if (cfg.perRound == 0 || cfg.rounds == 0 || cfg.threshold == 0) revert InvalidConfig();
        if (cfg.submitWindow == 0 || cfg.attestWindow == 0 || cfg.depositWindow == 0) revert InvalidConfig();
        uint256 n = members_.length;
        if (n < 2 || n > 20) revert InvalidMembers();
        if (cfg.threshold > n - 1) revert InvalidConfig(); // 본인 제외 인원보다 클 수 없음
        for (uint256 i = 0; i < n; i++) {
            address m = members_[i];
            if (m == address(0) || _memberIdx1[m] != 0) revert InvalidMembers();
            _memberIdx1[m] = i + 1;
            _members.push(m);
        }
        token = token_;
        sbt = sbt_;
        admin = msg.sender;
        config = cfg;
        createdAt = uint64(block.timestamp);
        state = StudyState.Created;
    }

    // =========================================================
    // 1. 자산 흐름
    // =========================================================

    /// @notice 보증금 전액(perRound × rounds) 예치. 사전에 token.approve(이 컨트랙트, 금액) 필요.
    function deposit() external nonReentrant {
        if (state != StudyState.Created) revert WrongState();
        if (!isMember(msg.sender)) revert NotMember();
        if (deposited[msg.sender]) revert AlreadyDeposited();
        if (block.timestamp > createdAt + config.depositWindow) revert DepositWindowClosed();

        uint256 total = totalDeposit();
        deposited[msg.sender] = true;
        lockedOf[msg.sender] = total;
        depositedCount += 1;
        token.safeTransferFrom(msg.sender, address(this), total);
        emit Deposited(msg.sender, total);

        if (depositedCount == _members.length) {
            state = StudyState.Active;
            startedAt = uint64(block.timestamp);
            emit StudyStarted(startedAt);
        }
    }

    /// @notice 예치 기한 내 전원 미예치 시 취소. 예치자 전액 환불(withdraw로 인출). 누구나 호출.
    function cancelStudy() external {
        if (state != StudyState.Created) revert WrongState();
        if (block.timestamp <= createdAt + config.depositWindow) revert DepositWindowOpen();
        state = StudyState.Cancelled;
        for (uint256 i = 0; i < _members.length; i++) {
            address m = _members[i];
            uint256 amt = lockedOf[m];
            if (amt > 0) {
                lockedOf[m] = 0;
                balanceOf[m] += amt;
                emit Refunded(m, amt);
            }
        }
        emit StudyCancelled(uint64(block.timestamp));
    }

    /// @notice 환급금·분배금 인출 (pull 패턴, CEI).
    function withdraw() external nonReentrant {
        uint256 amt = balanceOf[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        balanceOf[msg.sender] = 0;
        token.safeTransfer(msg.sender, amt);
        emit Withdrawn(msg.sender, amt);
    }

    // =========================================================
    // 2. 회차 진행
    // =========================================================

    /// @notice 다음 회차 시작. 이전 회차가 정산된 뒤에만 가능. 누구나 호출.
    function openRound() external {
        if (state != StudyState.Active) revert WrongState();
        if (currentRound > 0 && !_rounds[currentRound].settled) revert PreviousRoundNotSettled();
        if (currentRound >= config.rounds) revert AllRoundsDone();

        uint16 r = ++currentRound;
        Round storage rd = _rounds[r];
        rd.openedAt = uint64(block.timestamp);
        rd.proofDeadline = rd.openedAt + config.submitWindow;
        rd.lateDeadline = rd.proofDeadline + config.lateWindow;
        rd.attestDeadline = rd.lateDeadline + config.attestWindow;
        emit RoundOpened(r, rd.proofDeadline, rd.lateDeadline, rd.attestDeadline);
    }

    /// @notice 학습 증빙(캡처 이미지) 해시 제출. 증빙 마감 후 지각 마감 전이면 late = true.
    function submitProof(bytes32 proofHash) external {
        if (state != StudyState.Active) revert WrongState();
        if (!isMember(msg.sender)) revert NotMember();
        if (proofHash == bytes32(0)) revert EmptyHash();
        uint16 r = currentRound;
        Round storage rd = _rounds[r];
        if (r == 0 || rd.settled) revert RoundNotOpen();
        if (block.timestamp > rd.lateDeadline) revert ProofWindowClosed();
        MemberRound storage x = _mr[r][msg.sender];
        if (x.proofHash != bytes32(0)) revert ProofAlreadySubmitted();

        x.proofHash = proofHash;
        x.proofAt = uint64(block.timestamp);
        x.late = block.timestamp > rd.proofDeadline;
        emit ProofSubmitted(r, msg.sender, proofHash, x.late);
    }

    /// @notice 다른 멤버의 증빙 확인 서명. 본인 확인 불가, 중복 불가, 확인 마감 전까지.
    function attest(address member) external {
        if (state != StudyState.Active) revert WrongState();
        if (!isMember(msg.sender) || !isMember(member)) revert NotMember();
        if (member == msg.sender) revert SelfAttest();
        uint16 r = currentRound;
        Round storage rd = _rounds[r];
        if (r == 0 || rd.settled) revert RoundNotOpen();
        if (block.timestamp > rd.attestDeadline) revert AttestWindowClosed();
        MemberRound storage x = _mr[r][member];
        if (x.proofHash == bytes32(0)) revert NoProof();
        if (hasAttested[r][member][msg.sender]) revert AlreadyAttested();

        hasAttested[r][member][msg.sender] = true;
        _attesters[r][member].push(msg.sender);
        x.attestCount += 1;
        emit Attested(r, member, msg.sender, x.attestCount);
    }

    /// @notice 공결 설정. [임시] admin 전용. 플랜 B에서 DAO 투표(신청자 제외 과반) 통과 시 자동 호출로 대체.
    function setExcuse(uint16 round, address member) external {
        if (msg.sender != admin) revert NotAdmin();
        if (!isMember(member)) revert NotMember();
        if (round == 0 || round > config.rounds) revert InvalidRound();
        if (round <= currentRound && _rounds[round].settled) revert AlreadySettled();
        _mr[round][member].excused = true;
        emit ExcuseSet(round, member);
    }

    /// @notice 회차 정산. 확인 마감 후 누구나 호출, 회차당 1회.
    ///   Present: 회차 몫 환급 + SBT + 분배 수령 / Late: 50% 환급, 50% 몰수 /
    ///   Absent: 전액 몰수 / Excused: 전액 환급(SBT 없음, 개근 미인정).
    ///   몰수액 + 이월액을 Present에게 균등 분배, 나머지는 remainderPool, Present 0명이면 carryPool로 이월.
    function settleRound() external {
        if (state != StudyState.Active) revert WrongState();
        uint16 r = currentRound;
        Round storage rd = _rounds[r];
        if (r == 0) revert RoundNotOpen();
        if (rd.settled) revert AlreadySettled();
        if (block.timestamp <= rd.attestDeadline) revert TooEarlyToSettle();
        rd.settled = true;

        uint256 perRound = config.perRound;
        uint256 pool = carryPool;
        carryPool = 0;
        uint16 present = 0;

        for (uint256 i = 0; i < _members.length; i++) {
            address m = _members[i];
            MemberRound storage x = _mr[r][m];
            lockedOf[m] -= perRound;
            uint256 refund;
            if (x.excused) {
                x.status = Attendance.Excused;
                refund = perRound;
            } else if (x.proofHash != bytes32(0) && x.attestCount >= config.threshold) {
                if (x.late) {
                    x.status = Attendance.Late;
                    refund = perRound / 2;
                    pool += perRound - refund;
                } else {
                    x.status = Attendance.Present;
                    refund = perRound;
                    present += 1;
                    attendCount[m] += 1;
                    sbt.mintRound(m, r, x.attestCount);
                }
            } else {
                x.status = Attendance.Absent;
                pool += perRound;
            }
            if (refund > 0) balanceOf[m] += refund;
            emit AttendanceJudged(r, m, x.status, refund);
        }

        rd.presentCount = present;
        rd.pool = pool;
        uint256 share = 0;
        if (present == 0) {
            carryPool = pool; // 전원 결석: 다음 회차로 이월
        } else {
            share = pool / present;
            remainderPool += pool - share * present;
            if (share > 0) {
                for (uint256 i = 0; i < _members.length; i++) {
                    address m = _members[i];
                    if (_mr[r][m].status == Attendance.Present) {
                        balanceOf[m] += share;
                        emit Distributed(r, m, share);
                    }
                }
            }
        }
        emit RoundSettled(r, present, pool, share);
    }

    /// @notice 최종 정산. 전 회차 정산 후 누구나 호출.
    ///   개근자(attendCount == rounds)에게 개근 SBT 발행, 남은 풀(이월+나머지)을 개근자(없으면 전원)에게 분배.
    function finalizeStudy() external {
        if (state != StudyState.Active) revert WrongState();
        if (currentRound != config.rounds || !_rounds[currentRound].settled) revert NotAllSettled();
        state = StudyState.Finalized;

        uint256 left = carryPool + remainderPool;
        carryPool = 0;
        remainderPool = 0;

        uint256 n = _members.length;
        uint16 perfect = 0;
        for (uint256 i = 0; i < n; i++) {
            if (attendCount[_members[i]] == config.rounds) {
                perfect += 1;
                sbt.mintPerfect(_members[i]);
            }
        }

        if (left > 0) {
            uint256 k = perfect > 0 ? perfect : n;
            uint256 share = left / k;
            uint256 dust = left - share * k;
            for (uint256 i = 0; i < n; i++) {
                address m = _members[i];
                if (perfect > 0 && attendCount[m] != config.rounds) continue;
                uint256 amt = share + dust; // 첫 수령자가 dust까지 받아 잔액 0
                dust = 0;
                if (amt > 0) {
                    balanceOf[m] += amt;
                    emit Distributed(0, m, amt);
                }
            }
        }
        emit StudyFinalized(perfect, left);
    }

    // =========================================================
    // 3. 조회 (가스비 없음)
    // =========================================================

    function isMember(address a) public view returns (bool) {
        return _memberIdx1[a] != 0;
    }

    function memberIndex(address a) external view returns (uint256) {
        if (_memberIdx1[a] == 0) revert NotMember();
        return _memberIdx1[a] - 1;
    }

    function getMembers() external view returns (address[] memory) {
        return _members;
    }

    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    function totalDeposit() public view returns (uint256) {
        return config.perRound * config.rounds;
    }

    function getRound(uint16 r) external view returns (Round memory) {
        return _rounds[r];
    }

    function getMemberRound(uint16 r, address m) external view returns (MemberRound memory) {
        return _mr[r][m];
    }

    function getAttesters(uint16 r, address m) external view returns (address[] memory) {
        return _attesters[r][m];
    }

    /// @notice 현재 회차의 단계. 0 없음 / 1 증빙 제출 / 2 지각 제출 / 3 상호 확인 / 4 정산 대기 / 5 정산 완료
    function phase() external view returns (uint8) {
        uint16 r = currentRound;
        if (r == 0) return 0;
        Round storage rd = _rounds[r];
        if (rd.settled) return 5;
        if (block.timestamp <= rd.proofDeadline) return 1;
        if (block.timestamp <= rd.lateDeadline) return 2;
        if (block.timestamp <= rd.attestDeadline) return 3;
        return 4;
    }
}
