const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DAY = 86400;
const PER = ethers.parseUnits("5000", 18);
const TOTAL = PER * 7n;
const CFG = { perRound: PER, rounds: 7, threshold: 3, depositWindow: 3 * DAY, submitWindow: 7 * DAY, lateWindow: DAY, attestWindow: DAY };
const hash = (s) => ethers.id(s);
const units = (n) => ethers.parseUnits(String(n), 18);

async function deployFixture(cfg = CFG) {
  const [admin, a, b, c, d, e, f, outsider] = await ethers.getSigners();
  const members = [a, b, c, d, e, f];
  const sdt = await (await ethers.getContractFactory("MockSDT")).deploy();
  const sbt = await (await ethers.getContractFactory("AttendanceSBT")).deploy();
  const addrs = members.map((m) => m.address);
  const escrow = await (await ethers.getContractFactory("StudyEscrow")).deploy(await sdt.getAddress(), await sbt.getAddress(), addrs, cfg);
  await sbt.setEscrow(await escrow.getAddress());
  const total = cfg.perRound * BigInt(cfg.rounds);
  for (const m of [...members, outsider]) {
    await sdt.connect(m).faucet(units(100000));
    await sdt.connect(m).approve(await escrow.getAddress(), total);
  }
  return { admin, members, outsider, sdt, sbt, escrow, a, b, c, d, e, f };
}
async function activeFixture() {
  const x = await deployFixture();
  for (const m of x.members) await x.escrow.connect(m).deposit();
  return x;
}
async function openFixture() {
  const x = await activeFixture();
  await x.escrow.openRound();
  return x;
}
/** 회차 하나를 진행한다. plan[i]: "present" | "late" | "absent" */
async function playRound(x, plan, label = "r") {
  const { escrow, members } = x;
  const r = await escrow.currentRound();
  const rd = await escrow.getRound(r);
  const on = members.filter((_, i) => plan[i] === "present");
  for (const m of on) await escrow.connect(m).submitProof(hash(`${label}${r}-${m.address}`));
  const late = members.filter((_, i) => plan[i] === "late");
  if (late.length) {
    await time.increaseTo(rd.proofDeadline + 1n);
    for (const m of late) await escrow.connect(m).submitProof(hash(`${label}${r}-${m.address}`));
  }
  for (const target of [...on, ...late]) {
    let n = 0;
    for (const m of members) {
      if (m === target || n === 3) continue;
      await escrow.connect(m).attest(target.address);
      n++;
    }
  }
  await time.increaseTo(rd.attestDeadline + 1n);
  await escrow.settleRound();
}
const ALL = Array(6).fill("present");
const ONE_ABSENT = [...Array(5).fill("present"), "absent"];

describe("예치", () => {
  it("전원이 예치하면 Active가 되고 총액이 컨트랙트에 보관된다", async () => {
    const { escrow, sdt } = await loadFixture(activeFixture);
    expect(await escrow.state()).to.equal(1);
    expect(await sdt.balanceOf(await escrow.getAddress())).to.equal(TOTAL * 6n);
  });
  it("비회원, 중복, 기한 초과 예치는 거부된다", async () => {
    const { escrow, outsider, a, b } = await loadFixture(deployFixture);
    await expect(escrow.connect(outsider).deposit()).to.be.revertedWithCustomError(escrow, "NotMember");
    await escrow.connect(a).deposit();
    await expect(escrow.connect(a).deposit()).to.be.revertedWithCustomError(escrow, "AlreadyDeposited");
    await time.increase(3 * DAY + 1);
    await expect(escrow.connect(b).deposit()).to.be.revertedWithCustomError(escrow, "DepositWindowClosed");
  });
  it("기한 내 전원 미예치면 취소되고 예치자는 전액 인출한다", async () => {
    const { escrow, sdt, a } = await loadFixture(deployFixture);
    await escrow.connect(a).deposit();
    await expect(escrow.cancelStudy()).to.be.revertedWithCustomError(escrow, "DepositWindowOpen");
    await time.increase(3 * DAY + 1);
    await escrow.cancelStudy();
    await escrow.connect(a).withdraw();
    expect(await sdt.balanceOf(a.address)).to.equal(units(100000));
    expect(await sdt.balanceOf(await escrow.getAddress())).to.equal(0n);
  });
});

describe("증빙과 상호 확인", () => {
  it("마감 안 제출은 정상, 지각 구간 제출은 late, 그 뒤는 거부된다", async () => {
    const { escrow, a, b, c } = await loadFixture(openFixture);
    await escrow.connect(a).submitProof(hash("a"));
    expect((await escrow.getMemberRound(1, a.address)).late).to.equal(false);
    const rd = await escrow.getRound(1);
    await time.increaseTo(rd.proofDeadline + 1n);
    await escrow.connect(b).submitProof(hash("b"));
    expect((await escrow.getMemberRound(1, b.address)).late).to.equal(true);
    await time.increaseTo(rd.lateDeadline + 1n);
    await expect(escrow.connect(c).submitProof(hash("c"))).to.be.revertedWithCustomError(escrow, "ProofWindowClosed");
  });
  it("빈 해시와 재제출은 거부된다", async () => {
    const { escrow, a } = await loadFixture(openFixture);
    await expect(escrow.connect(a).submitProof(ethers.ZeroHash)).to.be.revertedWithCustomError(escrow, "EmptyHash");
    await escrow.connect(a).submitProof(hash("a"));
    await expect(escrow.connect(a).submitProof(hash("a2"))).to.be.revertedWithCustomError(escrow, "ProofAlreadySubmitted");
  });
  it("본인 확인, 비회원 확인, 증빙 없는 확인, 중복 확인, 마감 후 확인은 거부된다", async () => {
    const { escrow, a, b, c, outsider } = await loadFixture(openFixture);
    await expect(escrow.connect(b).attest(a.address)).to.be.revertedWithCustomError(escrow, "NoProof");
    await escrow.connect(a).submitProof(hash("a"));
    await expect(escrow.connect(a).attest(a.address)).to.be.revertedWithCustomError(escrow, "SelfAttest");
    await expect(escrow.connect(outsider).attest(a.address)).to.be.revertedWithCustomError(escrow, "NotMember");
    await escrow.connect(b).attest(a.address);
    await expect(escrow.connect(b).attest(a.address)).to.be.revertedWithCustomError(escrow, "AlreadyAttested");
    await time.increaseTo((await escrow.getRound(1)).attestDeadline + 1n);
    await expect(escrow.connect(c).attest(a.address)).to.be.revertedWithCustomError(escrow, "AttestWindowClosed");
  });
});

describe("회차 정산 (PDF 15쪽)", () => {
  it("6명 중 1명 결석이면 출석자는 6,000을 받고 결석자는 0이다", async () => {
    const x = await loadFixture(openFixture);
    await playRound(x, ONE_ABSENT);
    expect(await x.escrow.balanceOf(x.a.address)).to.equal(units(6000));
    expect(await x.escrow.balanceOf(x.f.address)).to.equal(0n);
    expect((await x.escrow.getMemberRound(1, x.f.address)).status).to.equal(3);
    expect(await x.sbt.balanceOf(x.a.address)).to.equal(1n);
    expect(await x.sbt.balanceOf(x.f.address)).to.equal(0n);
  });
  it("지각자는 50%만 받고 나머지 50%는 출석자에게 분배된다", async () => {
    const x = await loadFixture(openFixture);
    await playRound(x, [...Array(5).fill("present"), "late"]);
    expect(await x.escrow.balanceOf(x.f.address)).to.equal(units(2500));
    expect(await x.escrow.balanceOf(x.a.address)).to.equal(units(5500));
    expect(await x.sbt.balanceOf(x.f.address)).to.equal(0n);
  });
  it("확인 2명이면 결석, 3명이면 출석이다", async () => {
    const { escrow, a, b, c, d, e } = await loadFixture(openFixture);
    await escrow.connect(a).submitProof(hash("a"));
    await escrow.connect(b).submitProof(hash("b"));
    await escrow.connect(c).attest(a.address); await escrow.connect(d).attest(a.address);
    await escrow.connect(c).attest(b.address); await escrow.connect(d).attest(b.address); await escrow.connect(e).attest(b.address);
    await time.increaseTo((await escrow.getRound(1)).attestDeadline + 1n);
    await escrow.settleRound();
    expect((await escrow.getMemberRound(1, a.address)).status).to.equal(3);
    expect((await escrow.getMemberRound(1, b.address)).status).to.equal(1);
  });
  it("전원 결석이면 몰수분이 다음 회차로 이월되어 출석자에게 분배된다", async () => {
    const x = await loadFixture(openFixture);
    await playRound(x, Array(6).fill("absent"));
    expect(await x.escrow.carryPool()).to.equal(PER * 6n);
    await x.escrow.openRound();
    await playRound(x, ALL);
    expect(await x.escrow.carryPool()).to.equal(0n);
    expect(await x.escrow.balanceOf(x.a.address)).to.equal(PER + PER);
  });
  it("공결은 회차 몫을 돌려받고 SBT와 개근 인정은 없다", async () => {
    const x = await loadFixture(openFixture);
    await x.escrow.setExcuse(1, x.f.address);
    await playRound(x, ONE_ABSENT);
    expect(await x.escrow.balanceOf(x.f.address)).to.equal(PER);
    expect(await x.escrow.balanceOf(x.a.address)).to.equal(PER);
    expect(await x.sbt.balanceOf(x.f.address)).to.equal(0n);
    expect(await x.escrow.attendCount(x.f.address)).to.equal(0n);
  });
  it("마감 전 정산, 중복 정산, 정산 전 다음 회차 열기는 거부된다", async () => {
    const x = await loadFixture(openFixture);
    await expect(x.escrow.settleRound()).to.be.revertedWithCustomError(x.escrow, "TooEarlyToSettle");
    await expect(x.escrow.openRound()).to.be.revertedWithCustomError(x.escrow, "PreviousRoundNotSettled");
    await time.increaseTo((await x.escrow.getRound(1)).attestDeadline + 1n);
    await x.escrow.settleRound();
    await expect(x.escrow.settleRound()).to.be.revertedWithCustomError(x.escrow, "AlreadySettled");
  });
  it("공결 설정은 배포자만 가능하고, 정산된 회차에는 불가능하다", async () => {
    const x = await loadFixture(openFixture);
    await expect(x.escrow.connect(x.a).setExcuse(1, x.f.address)).to.be.revertedWithCustomError(x.escrow, "NotAdmin");
    await time.increaseTo((await x.escrow.getRound(1)).attestDeadline + 1n);
    await x.escrow.settleRound();
    await expect(x.escrow.setExcuse(1, x.f.address)).to.be.revertedWithCustomError(x.escrow, "AlreadySettled");
  });
});

describe("최종 정산과 자금 보존", () => {
  async function playAll(x, plans) {
    for (const plan of plans) {
      await x.escrow.openRound();
      await playRound(x, plan);
    }
  }
  it("7회 개근자는 개근 SBT를 받고, 모두 인출하면 컨트랙트 잔액은 0이다", async () => {
    const x = await loadFixture(activeFixture);
    await playAll(x, Array(7).fill(ONE_ABSENT));
    await x.escrow.finalizeStudy();
    expect(await x.escrow.state()).to.equal(3);
    expect(await x.sbt.balanceOf(x.a.address)).to.equal(8n); // 회차 7 + 개근 1
    for (const m of x.members) if ((await x.escrow.balanceOf(m.address)) > 0n) await x.escrow.connect(m).withdraw();
    expect(await x.sdt.balanceOf(await x.escrow.getAddress())).to.equal(0n);
    expect(await x.sdt.balanceOf(x.a.address)).to.equal(units(100000) + units(7000)); // 35,000 예치, 42,000 수령
    expect(await x.sdt.balanceOf(x.f.address)).to.equal(units(100000) - TOTAL);
  });
  it("나누어떨어지지 않는 끝전까지 포함해 1 wei도 남지 않는다", async () => {
    const cfg = { ...CFG, perRound: PER + 1n };
    const x = await deployFixture(cfg);
    for (const m of x.members) await x.escrow.connect(m).deposit();
    await playAll(x, Array(7).fill(ONE_ABSENT));
    expect(await x.escrow.remainderPool()).to.be.greaterThan(0n);
    await x.escrow.finalizeStudy();
    expect(await x.escrow.remainderPool()).to.equal(0n);
    for (const m of x.members) if ((await x.escrow.balanceOf(m.address)) > 0n) await x.escrow.connect(m).withdraw();
    expect(await x.sdt.balanceOf(await x.escrow.getAddress())).to.equal(0n);
  });
  it("지각·공결·전원 결석이 섞여도 자금이 보존된다", async () => {
    const x = await loadFixture(activeFixture);
    const late = ["present", "late", "absent", "present", "present", "absent"];
    await x.escrow.setExcuse(3, x.c.address);
    await playAll(x, [ALL, late, ONE_ABSENT, Array(6).fill("absent"), ALL, late, Array(6).fill("absent")]);
    await x.escrow.finalizeStudy();
    let sum = 0n;
    for (const m of x.members) sum += await x.escrow.balanceOf(m.address);
    expect(sum).to.equal(TOTAL * 6n);
  });
  it("개근자가 없으면 남은 잔액을 전원에게 나눈다", async () => {
    const x = await loadFixture(activeFixture);
    await playAll(x, [...Array(6).fill(ALL), Array(6).fill("absent")]);
    expect(await x.escrow.carryPool()).to.equal(PER * 6n);
    await x.escrow.finalizeStudy();
    expect(await x.escrow.balanceOf(x.a.address)).to.equal(PER * 7n);
  });
  it("모든 회차 정산 전 최종 정산과 잔액 없는 인출은 거부된다", async () => {
    const x = await loadFixture(openFixture);
    await expect(x.escrow.finalizeStudy()).to.be.revertedWithCustomError(x.escrow, "NotAllSettled");
    await expect(x.escrow.connect(x.a).withdraw()).to.be.revertedWithCustomError(x.escrow, "NothingToWithdraw");
  });
});

describe("출석 SBT (PDF 11쪽)", () => {
  it("전송과 승인이 막혀 있고 ERC-5192를 지원한다", async () => {
    const x = await loadFixture(openFixture);
    await playRound(x, ALL);
    const id = 1n;
    expect(await x.sbt.ownerOf(id)).to.equal(x.a.address);
    expect(await x.sbt.locked(id)).to.equal(true);
    expect(await x.sbt.supportsInterface("0xb45a3c0e")).to.equal(true);
    await expect(x.sbt.connect(x.a).transferFrom(x.a.address, x.b.address, id)).to.be.revertedWithCustomError(x.sbt, "Soulbound");
    await expect(x.sbt.connect(x.a).approve(x.b.address, id)).to.be.revertedWithCustomError(x.sbt, "Soulbound");
    await expect(x.sbt.connect(x.a).setApprovalForAll(x.b.address, true)).to.be.revertedWithCustomError(x.sbt, "Soulbound");
  });
  it("발행은 에스크로만, 소각은 DAO만 가능하다", async () => {
    const x = await loadFixture(openFixture);
    await playRound(x, ALL);
    await expect(x.sbt.connect(x.a).mintRound(x.a.address, 1, 3)).to.be.revertedWithCustomError(x.sbt, "NotEscrow");
    await expect(x.sbt.connect(x.a).burn(1)).to.be.revertedWithCustomError(x.sbt, "NotDao");
  });
});

// 아래는 PDF와 다르거나 설계상 위험한 "현재 동작"을 기록한다. 고치면 이 테스트도 함께 바꿔야 한다.
describe("[알려진 문제] 현재 동작 기록", () => {
  it("7일째(다음 회차 시작 시각)에 다음 회차를 열 수 없고, 빨라도 9일 뒤에 열린다", async () => {
    const { escrow } = await loadFixture(openFixture);
    const opened = (await escrow.getRound(1)).openedAt;
    await time.increaseTo(opened + BigInt(7 * DAY));
    await expect(escrow.openRound()).to.be.revertedWithCustomError(escrow, "PreviousRoundNotSettled");
    await time.increaseTo(opened + BigInt(9 * DAY) + 1n);
    await escrow.settleRound();
    await escrow.openRound();
    const gap = (await escrow.getRound(2)).openedAt - opened;
    expect(gap).to.be.greaterThan(BigInt(9 * DAY));
  });
  it("마감은 요일이 아니라 회차를 연 시각 기준이다", async () => {
    const { escrow } = await loadFixture(activeFixture);
    await time.increase(12345);
    await escrow.openRound();
    const rd = await escrow.getRound(1);
    expect(rd.proofDeadline - rd.openedAt).to.equal(BigInt(7 * DAY));
  });
  it("3명이 확인을 거부하면 증빙을 낸 사람이 결석 처리되고 몰수분은 출석자에게 간다", async () => {
    const x = await loadFixture(openFixture);
    const { escrow, a, b, c, d, e, f } = x;
    const colluders = [a, b, c], others = [d, e], victim = f;
    await escrow.connect(victim).submitProof(hash("victim"));
    for (const m of [...colluders, ...others]) await escrow.connect(m).submitProof(hash(m.address));
    for (const t of colluders) { let n = 0; for (const m of [...colluders, ...others]) { if (m !== t && n < 3) { await escrow.connect(m).attest(t.address); n++; } } }
    for (const t of others) for (const m of colluders) await escrow.connect(m).attest(t.address);
    for (const m of others) await escrow.connect(m).attest(victim.address);  // 나머지 2명만 확인 가능
    await time.increaseTo((await escrow.getRound(1)).attestDeadline + 1n);
    await escrow.settleRound();
    expect((await escrow.getMemberRound(1, victim.address)).status).to.equal(3);
    expect(await escrow.balanceOf(victim.address)).to.equal(0n);
    expect(await escrow.balanceOf(a.address)).to.equal(units(6000));
  });
  it("배포자가 공결로 처리하면 실제 출석자도 SBT와 개근 인정을 잃고, 취소 함수도 없다", async () => {
    const x = await loadFixture(openFixture);
    await x.escrow.setExcuse(1, x.a.address);
    await playRound(x, ALL);
    expect((await x.escrow.getMemberRound(1, x.a.address)).status).to.equal(4);
    expect(await x.sbt.balanceOf(x.a.address)).to.equal(0n);
    expect(await x.escrow.attendCount(x.a.address)).to.equal(0n);
    expect(x.escrow.interface.fragments.some((f) => /unsetExcuse|clearExcuse/i.test(f.name || ""))).to.equal(false);
  });
  it("SBT에는 확인받은 수만 있고, 확인해 준 횟수(PDF 15쪽)는 기록되지 않는다", async () => {
    const x = await loadFixture(openFixture);
    await playRound(x, ALL);
    const info = await x.sbt.info(1);
    expect(info.attestCount).to.equal(3n);
    expect(Object.keys(info.toObject())).to.not.include("attestGiven");
  });
  it("비회원도 회차를 열 수 있다 (PDF 23쪽은 등록 지갑만 호출)", async () => {
    const { escrow, outsider } = await loadFixture(activeFixture);
    await escrow.connect(outsider).openRound();
    expect(await escrow.currentRound()).to.equal(1n);
  });
  it("다른 사람과 같은 해시, 지난 회차와 같은 해시도 제출된다", async () => {
    const x = await loadFixture(openFixture);
    await x.escrow.connect(x.a).submitProof(hash("same"));
    await x.escrow.connect(x.b).submitProof(hash("same"));
    await time.increaseTo((await x.escrow.getRound(1)).attestDeadline + 1n);
    await x.escrow.settleRound();
    await x.escrow.openRound();
    await x.escrow.connect(x.a).submitProof(hash("same"));
    expect((await x.escrow.getMemberRound(2, x.a.address)).proofHash).to.equal(hash("same"));
  });
  it("PDF 구현 계획의 함수 중 DAO·이의 제기·탈퇴 함수가 없다", async () => {
    const { escrow } = await loadFixture(deployFixture);
    const names = escrow.interface.fragments.map((f) => f.name);
    for (const n of ["propose", "vote", "executeProposal", "raiseDispute", "leaveStudy"]) expect(names).to.not.include(n);
  });
});
