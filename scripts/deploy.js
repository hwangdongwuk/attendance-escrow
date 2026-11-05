// 배포 스크립트: MockSDT → AttendanceSBT → StudyEscrow → sbt.setEscrow
// 결과는 web/config.js(주소·설정)와 web/abi.js(ABI)로 기록되어 프론트가 file://로도 읽는다.
//
//   npm run deploy:local     (hardhat node 실행 중일 때, 로컬 데모용 짧은 마감)
//   npm run deploy:sepolia   (.env: SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, MEMBERS=0x..,0x..)
//
// 환경변수(선택): PER_ROUND(기본 5000), ROUNDS(7), THRESHOLD(3),
//   DEPOSIT_WINDOW, SUBMIT_WINDOW, LATE_WINDOW, ATTEST_WINDOW (초)
const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

const isLocal = network.name === "hardhat" || network.name === "localhost";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  // ---- 멤버 ----
  let members;
  if (process.env.MEMBERS) {
    members = process.env.MEMBERS.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (isLocal) {
    members = signers.slice(1, 7).map((s) => s.address); // 계정 1~6 = 스터디원 6명
  } else {
    throw new Error("MEMBERS 환경변수(쉼표 구분 지갑 주소 6개)가 필요합니다.");
  }

  // ---- 설정 (PDF 13쪽 시간 정책: 제출 7일, 지각 1일, 확인 1일, 예치 3일) ----
  const env = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
  const cfg = {
    perRound: ethers.parseUnits(String(env("PER_ROUND", 5000)), 18),
    rounds: env("ROUNDS", 7),
    threshold: env("THRESHOLD", 3),
    depositWindow: env("DEPOSIT_WINDOW", isLocal ? 86400 : 3 * 86400),
    submitWindow: env("SUBMIT_WINDOW", isLocal ? 600 : 7 * 86400),
    lateWindow: env("LATE_WINDOW", isLocal ? 300 : 86400),
    attestWindow: env("ATTEST_WINDOW", isLocal ? 300 : 86400),
  };

  // ---- 배포 ----
  const sdt = await (await ethers.getContractFactory("MockSDT")).deploy();
  await sdt.waitForDeployment();
  const sbt = await (await ethers.getContractFactory("AttendanceSBT")).deploy();
  await sbt.waitForDeployment();
  const escrow = await (await ethers.getContractFactory("StudyEscrow")).deploy(
    await sdt.getAddress(), await sbt.getAddress(), members, cfg
  );
  await escrow.waitForDeployment();
  await (await sbt.setEscrow(await escrow.getAddress())).wait();

  // 로컬: 멤버 6명에게 SDT 지급 (faucet은 호출자에게 민팅)
  if (isLocal && !process.env.MEMBERS) {
    const amt = ethers.parseUnits("100000", 18);
    for (const s of signers.slice(1, 7)) await (await sdt.connect(s).faucet(amt)).wait();
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const out = {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    deployBlock: (await escrow.deploymentTransaction().wait()).blockNumber, // 프론트의 이벤트 조회 시작 블록
    deployer: deployer.address,
    sdt: await sdt.getAddress(),
    sbt: await sbt.getAddress(),
    escrow: await escrow.getAddress(),
    members,
    config: {
      perRound: cfg.perRound.toString(),
      rounds: cfg.rounds, threshold: cfg.threshold,
      depositWindow: cfg.depositWindow, submitWindow: cfg.submitWindow,
      lateWindow: cfg.lateWindow, attestWindow: cfg.attestWindow,
    },
  };

  // ---- 프론트용 파일 ----
  const webDir = path.join(__dirname, "..", "web");
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, "config.js"),
    "// deploy.js가 생성. 직접 수정하지 말 것.\nwindow.APP_CONFIG = " + JSON.stringify(out, null, 2) + ";\n");
  const abi = {};
  for (const n of ["MockSDT", "AttendanceSBT", "StudyEscrow"]) abi[n] = (await artifacts.readArtifact(n)).abi;
  fs.writeFileSync(path.join(webDir, "abi.js"),
    "// deploy.js가 생성. 직접 수정하지 말 것.\nwindow.APP_ABI = " + JSON.stringify(abi) + ";\n");
  fs.writeFileSync(path.join(__dirname, "..", `deployments.${network.name}.json`), JSON.stringify(out, null, 2));

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
