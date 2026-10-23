const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AttendanceEscrow 골격", function () {
  it("배포되고 보증금 금액을 보관한다", async function () {
    const amount = ethers.parseEther("0.01");
    const Escrow = await ethers.getContractFactory("AttendanceEscrow");
    const escrow = await Escrow.deploy(amount);
    await escrow.waitForDeployment();
    expect(await escrow.depositAmount()).to.equal(amount);
  });
});