const { ethers, network } = require("hardhat");

async function main() {
  const amount = ethers.parseEther("0.01"); // 보증금 [TBD: 조 확정값]
  const Escrow = await ethers.getContractFactory("AttendanceEscrow");
  const escrow = await Escrow.deploy(amount);
  await escrow.waitForDeployment();
  console.log(`network=${network.name} address=${await escrow.getAddress()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });