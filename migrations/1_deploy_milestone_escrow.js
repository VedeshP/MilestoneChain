const MilestoneEscrow = artifacts.require("MilestoneEscrow");

// Seconds the other party has to counter-stake a dispute before the disputer
// can claim a default win. Short for live demos; use days in production.
const RESPONSE_WINDOW = 120;

module.exports = function (deployer) {
  deployer.deploy(MilestoneEscrow, RESPONSE_WINDOW);
};
