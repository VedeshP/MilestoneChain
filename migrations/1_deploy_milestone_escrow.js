const MilestoneEscrow = artifacts.require("MilestoneEscrow");

// Seconds the other party has to counter-stake a dispute, and then the
// arbitrators have to vote. Short for live demos; use days in production.
const RESPONSE_WINDOW = 120;

module.exports = async function (deployer, network, accounts) {
  // accounts[0] deploys and becomes the platform owner
  await deployer.deploy(MilestoneEscrow, RESPONSE_WINDOW);
  const escrow = await MilestoneEscrow.deployed();

  // Demo setup: accounts 3, 4, 5 join the arbitrator panel with a 1 ETH bond each.
  // (accounts 1 and 2 are left free to act as Client and Developer)
  const bond = web3.utils.toWei("1", "ether");
  for (const arbitrator of accounts.slice(3, 6)) {
    await escrow.joinPanel({ from: arbitrator, value: bond });
  }
};
