const MilestoneEscrow = artifacts.require("MilestoneEscrow");

const WINDOW = 120;

contract("MilestoneEscrow", (accounts) => {
  const [owner, client, developer, arb1, arb2, arb3, stranger] = accounts;
  const toWei = (e) => web3.utils.toWei(e, "ether");
  const half = toWei("0.5");
  const full = toWei("1");
  const bond = toWei("1");
  const hashA = "0x" + "a".repeat(64); // developer's hash
  const hashB = "0x" + "b".repeat(64); // wrong hash (tampered)

  // Fee figures for a 0.5 ETH milestone
  const stake = BigInt(toWei("0.025")); // 5%
  const arbFee = BigInt(toWei("0.005")); // 1%
  const platFee = BigInt(toWei("0.0025")); // 0.5%
  const arbSlash = BigInt(toWei("0.1"));

  let c;
  beforeEach(async () => {
    c = await MilestoneEscrow.new(WINDOW, { from: owner });
    for (const a of [arb1, arb2, arb3]) await c.joinPanel({ from: a, value: bond });
  });

  const bal = async (a) => BigInt(await web3.eth.getBalance(a));
  const gasCost = async (rx) => {
    const tx = await web3.eth.getTransaction(rx.tx);
    return BigInt(rx.receipt.gasUsed) * BigInt(tx.gasPrice);
  };
  // Balance change of `who` caused by `fn`, with gas added back if `who` sent the tx
  const delta = async (who, fn) => {
    const before = await bal(who);
    const rx = await fn();
    const after = await bal(who);
    const gas = rx.receipt.from.toLowerCase() === who.toLowerCase() ? await gasCost(rx) : 0n;
    return after - before + gas;
  };
  const expectRevert = async (p, msg) => {
    try {
      await p;
      assert.fail("expected revert");
    } catch (e) {
      assert.include(e.message, msg);
    }
  };
  const rpc = (method, params = []) =>
    new Promise((res, rej) =>
      web3.currentProvider.send({ jsonrpc: "2.0", method, params, id: Date.now() }, (e, r) => (e ? rej(e) : res(r)))
    );
  const timeTravel = async (s) => {
    await rpc("evm_increaseTime", [s]);
    await rpc("evm_mine");
  };

  const makeProject = () =>
    c.createProject("App", "desc", developer, ["M1", "M2"], [half, half], { from: client, value: full });
  const submit = (i = 0) => c.submitMilestone(1, i, hashA, `m${i}.zip`, 1, { from: developer });
  const disputeByClient = () => c.raiseDispute(1, 0, "Hash mismatch", { from: client, value: stake.toString() });
  // Project with M0 disputed by the client and contested by the developer — ready for votes
  const contested = async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await c.respondToDispute(1, { from: developer, value: stake.toString() });
  };

  // ── Core lifecycle ────────────────────────────────────────────────────
  it("TC-01 sets owner and response window on deploy", async () => {
    assert.equal(await c.owner(), owner);
    assert.equal((await c.responseWindow()).toNumber(), WINDOW);
  });

  it("TC-02 createProject locks ETH in contract", async () => {
    await makeProject();
    // contract also holds the three 1 ETH arbitrator bonds
    assert.equal(await bal(c.address), BigInt(full) + 3n * BigInt(bond));
  });

  it("TC-03 createProject reverts on wrong ETH amount", async () => {
    await expectRevert(
      c.createProject("App", "d", developer, ["M1"], [full], { from: client, value: half }),
      "ETH sent must equal"
    );
  });

  it("TC-04 createProject reverts if client = developer", async () => {
    await expectRevert(
      c.createProject("App", "d", client, ["M1"], [full], { from: client, value: full }),
      "Client cannot be developer"
    );
  });

  it("TC-05 developer submits milestone — status becomes Submitted", async () => {
    await makeProject();
    await submit();
    const m = await c.getMilestone(1, 0);
    assert.equal(m.status.toNumber(), 1);
    assert.equal(m.artifactName, "m0.zip");
  });

  it("TC-06 stranger cannot submit milestone", async () => {
    await makeProject();
    await expectRevert(c.submitMilestone(1, 0, hashA, "x", 1, { from: stranger }), "Not the developer");
  });

  it("TC-07 verifyDeliverable returns true when hashes match", async () => {
    await makeProject();
    await submit();
    assert.isTrue(await c.verifyDeliverable.call(1, 0, hashA, { from: client }));
  });

  it("TC-08 verifyDeliverable returns false when hashes differ", async () => {
    await makeProject();
    await submit();
    assert.isFalse(await c.verifyDeliverable.call(1, 0, hashB, { from: client }));
  });

  it("TC-09 verify sets isVerified on match; records client hash on mismatch", async () => {
    await makeProject();
    await submit();
    await c.verifyDeliverable(1, 0, hashB, { from: client });
    let m = await c.getMilestone(1, 0);
    assert.isFalse(m.isVerified);
    assert.equal(m.clientHash, hashB);
    await c.verifyDeliverable(1, 0, hashA, { from: client });
    m = await c.getMilestone(1, 0);
    assert.isTrue(m.isVerified);
    assert.equal(m.status.toNumber(), 2);
  });

  it("TC-10 approveMilestone reverts without verification", async () => {
    await makeProject();
    await submit();
    await expectRevert(c.approveMilestone(1, 0, { from: client }), "Deliverable not verified yet");
  });

  it("TC-11 approve pays developer 99.5% and platform 0.5%", async () => {
    await makeProject();
    await submit();
    await c.verifyDeliverable(1, 0, hashA, { from: client });
    const d = await delta(developer, () => c.approveMilestone(1, 0, { from: client }));
    assert.equal(d, BigInt(half) - platFee);
    assert.equal(BigInt(await c.platformBalance()), platFee);
  });

  it("TC-12 non-client cannot approve milestone", async () => {
    await makeProject();
    await submit();
    await c.verifyDeliverable(1, 0, hashA, { from: client });
    await expectRevert(c.approveMilestone(1, 0, { from: stranger }), "Not the client");
  });

  it("TC-13 completing all milestones sets project Completed", async () => {
    await makeProject();
    for (let i = 0; i < 2; i++) {
      await submit(i);
      await c.verifyDeliverable(1, i, hashA, { from: client });
      await c.approveMilestone(1, i, { from: client });
    }
    assert.equal((await c.getProject(1)).status.toNumber(), 1);
  });

  it("TC-14 client refunds project with no submitted milestones (no fee)", async () => {
    await makeProject();
    const d = await delta(client, () => c.refundClient(1, { from: client }));
    assert.equal(d, BigInt(full));
    assert.equal((await c.getProject(1)).status.toNumber(), 3);
  });

  // ── Disputes & staking ────────────────────────────────────────────────
  it("TC-15 raising a dispute requires exactly a 5% stake", async () => {
    await makeProject();
    await submit();
    await expectRevert(c.raiseDispute(1, 0, "bad", { from: client, value: "1" }), "Must stake exactly 5%");
    await disputeByClient();
    assert.equal((await c.getProject(1)).status.toNumber(), 2);
    const d = await c.getDispute(1);
    assert.deepEqual([...d.arbitrators], [arb1, arb2, arb3]);
  });

  it("TC-16 respondent must match the stake and respond in time", async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await expectRevert(c.respondToDispute(1, { from: developer, value: "1" }), "Must match");
    await expectRevert(c.respondToDispute(1, { from: stranger, value: stake.toString() }), "Not the respondent");
    await timeTravel(WINDOW + 1);
    await expectRevert(c.respondToDispute(1, { from: developer, value: stake.toString() }), "Response window closed");
  });

  it("TC-17 disputer wins by default if respondent never stakes", async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await expectRevert(c.claimDefault(1, { from: client }), "window still open");
    await timeTravel(WINDOW + 1);
    const d = await delta(client, () => c.claimDefault(1, { from: client }));
    assert.equal(d, BigInt(half) - platFee + stake);
    assert.equal(BigInt(await c.platformBalance()), platFee); // nothing slashed
    assert.equal((await c.openCases(arb1)).toNumber(), 0);
  });

  // ── Arbitrator panel voting ───────────────────────────────────────────
  it("TC-18 arbitrators cannot vote before the respondent counter-stakes", async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await expectRevert(c.vote(1, true, { from: arb1 }), "Respondent has not staked");
  });

  it("TC-19 only panel arbitrators can vote, and only once", async () => {
    await contested();
    await expectRevert(c.vote(1, true, { from: stranger }), "Not an arbitrator on this dispute");
    await expectRevert(c.vote(1, true, { from: client }), "Not an arbitrator on this dispute");
    await c.vote(1, true, { from: arb1 });
    await expectRevert(c.vote(1, false, { from: arb1 }), "Already voted");
  });

  it("TC-20 2 votes for the client: client refunded, developer slashed, majority split 1%", async () => {
    await contested();
    await c.vote(1, false, { from: arb1 });
    const clientBefore = await bal(client);
    const d2 = await delta(arb2, () => c.vote(1, false, { from: arb2 })); // 2nd vote settles it

    assert.equal((await bal(client)) - clientBefore, BigInt(half) - platFee + stake);
    assert.equal(d2, arbFee / 2n);
    assert.equal(BigInt(await c.platformBalance()), platFee + (stake - arbFee));
    assert.equal((await c.getMilestone(1, 0)).status.toNumber(), 5); // Refunded
    assert.equal((await c.getProject(1)).status.toNumber(), 0); // back to Active
    // arb3 never voted but wasn't needed — not slashed
    assert.equal(BigInt(await c.arbitratorBond(arb3)), BigInt(bond));
  });

  it("TC-21 2 votes for the developer: client's stake slashed, dissenting arbitrator slashed", async () => {
    await contested();
    await c.vote(1, false, { from: arb3 }); // minority vote
    await c.vote(1, true, { from: arb1 });
    const devBefore = await bal(developer);
    await c.vote(1, true, { from: arb2 });

    assert.equal((await bal(developer)) - devBefore, BigInt(half) - platFee + stake);
    assert.equal(BigInt(await c.arbitratorBond(arb3)), BigInt(bond) - arbSlash);
    assert.equal(BigInt(await c.arbitratorBond(arb1)), BigInt(bond));
    // platform: 0.5% fee + rest of client's stake + arb3's slash
    assert.equal(BigInt(await c.platformBalance()), platFee + (stake - arbFee) + arbSlash);
  });

  it("TC-22 no majority by deadline: respondent wins, non-voters slashed", async () => {
    await contested(); // client disputed → developer is respondent
    await c.vote(1, true, { from: arb1 });
    await expectRevert(c.finalizeDispute(1, { from: stranger }), "Voting still open");
    await timeTravel(WINDOW + 1);
    await expectRevert(c.vote(1, true, { from: arb2 }), "Voting closed");

    const devBefore = await bal(developer);
    const d1 = await delta(arb1, () => c.finalizeDispute(1, { from: stranger }));

    assert.equal((await bal(developer)) - devBefore, BigInt(half) - platFee + stake);
    assert.equal(d1, arbFee); // only voter on the winning side gets the whole 1%
    assert.equal(BigInt(await c.arbitratorBond(arb2)), BigInt(bond) - arbSlash);
    assert.equal(BigInt(await c.arbitratorBond(arb3)), BigInt(bond) - arbSlash);
  });

  it("TC-23 arbitrator removed from panel once bond falls below 0.5 ETH", async () => {
    // arb3 keeps voting against the majority on 6 separate disputes
    for (let i = 1; i <= 6; i++) {
      await c.createProject(`P${i}`, "d", developer, ["M"], [half], { from: client, value: half });
      await c.submitMilestone(i, 0, hashA, "a.zip", 1, { from: developer });
      await c.raiseDispute(i, 0, "x", { from: client, value: stake.toString() });
      await c.respondToDispute(i, { from: developer, value: stake.toString() });
      await c.vote(i, false, { from: arb3 });
      await c.vote(i, true, { from: arb1 });
      await c.vote(i, true, { from: arb2 });
    }
    assert.isFalse(await c.isArbitrator(arb3));
    assert.equal((await c.getPanel()).length, 2);
    await expectRevert(
      c.createProject("P7", "d", developer, ["M"], [half], { from: client, value: half }).then(() =>
        c.submitMilestone(7, 0, hashA, "a.zip", 1, { from: developer })
      ).then(() => c.raiseDispute(7, 0, "x", { from: client, value: stake.toString() })),
      "panel is not full"
    );
  });

  it("TC-24 panel rules: bond of exactly 1 ETH, max 3 seats, can't leave with open cases", async () => {
    await expectRevert(c.joinPanel({ from: stranger, value: bond }), "Panel is full");
    await contested();
    await expectRevert(c.leavePanel({ from: arb1 }), "Finish your open disputes");
    await c.vote(1, true, { from: arb1 });
    await c.vote(1, true, { from: arb2 });
    const d = await delta(arb3, () => c.leavePanel({ from: arb3 }));
    assert.equal(d, BigInt(bond));
    await expectRevert(c.joinPanel({ from: stranger, value: "1" }), "Bond must be exactly 1 ETH");
    await c.joinPanel({ from: stranger, value: bond });
    assert.isTrue(await c.isArbitrator(stranger));
  });

  it("TC-25 arbitrators cannot be a party to a project", async () => {
    await expectRevert(
      c.createProject("App", "d", arb1, ["M"], [half], { from: client, value: half }),
      "Arbitrators cannot be a party"
    );
  });

  it("TC-26 refunded milestone cannot be resubmitted; project completes after remaining approval", async () => {
    await contested();
    await c.vote(1, false, { from: arb1 });
    await c.vote(1, false, { from: arb2 });
    await expectRevert(submit(0), "already submitted or settled");
    await submit(1);
    await c.verifyDeliverable(1, 1, hashA, { from: client });
    await c.approveMilestone(1, 1, { from: client });
    assert.equal((await c.getProject(1)).status.toNumber(), 1);
    assert.equal(BigInt(await c.getRemainingBalance(1)), 0n);
  });

  it("TC-27 after everything settles, contract holds only fees + bonds; owner withdraws", async () => {
    await contested();
    await c.vote(1, true, { from: arb1 });
    await c.vote(1, false, { from: arb2 });
    await c.vote(1, true, { from: arb3 });
    await submit(1);
    await c.verifyDeliverable(1, 1, hashA, { from: client });
    await c.approveMilestone(1, 1, { from: client });

    const platform = BigInt(await c.platformBalance());
    let bonds = 0n;
    for (const a of [arb1, arb2, arb3]) bonds += BigInt(await c.arbitratorBond(a));
    assert.equal(await bal(c.address), platform + bonds);

    await expectRevert(c.withdrawPlatformFees({ from: stranger }), "Not the owner");
    const d = await delta(owner, () => c.withdrawPlatformFees({ from: owner }));
    assert.equal(d, platform);
    assert.equal(await bal(c.address), bonds);
  });
});
