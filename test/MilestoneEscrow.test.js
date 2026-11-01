const MilestoneEscrow = artifacts.require("MilestoneEscrow");

const WINDOW = 120;

contract("MilestoneEscrow", (accounts) => {
  const [owner, client, developer, arbitrator, stranger] = accounts;
  const toWei = (e) => web3.utils.toWei(e, "ether");
  const half = toWei("0.5");
  const full = toWei("1");
  const hashA = "0x" + "a".repeat(64); // developer's hash
  const hashB = "0x" + "b".repeat(64); // wrong hash (tampered)

  // Fee figures for a 0.5 ETH milestone
  const stake = BigInt(toWei("0.025")); // 5%
  const arbFee = BigInt(toWei("0.005")); // 1%
  const platFee = BigInt(toWei("0.0025")); // 0.5%

  let c;
  beforeEach(async () => {
    c = await MilestoneEscrow.new(WINDOW, { from: owner });
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
  const timeTravel = (s) =>
    new Promise((res, rej) =>
      web3.currentProvider.send(
        { jsonrpc: "2.0", method: "evm_increaseTime", params: [s], id: Date.now() },
        (err) => (err ? rej(err) : web3.currentProvider.send(
          { jsonrpc: "2.0", method: "evm_mine", params: [], id: Date.now() + 1 },
          (e2) => (e2 ? rej(e2) : res())
        ))
      )
    );

  const makeProject = () =>
    c.createProject("App", "desc", developer, arbitrator, ["M1", "M2"], [half, half], {
      from: client,
      value: full,
    });
  const submit = (i = 0) => c.submitMilestone(1, i, hashA, `m${i}.zip`, 1, { from: developer });
  const disputeByClient = () =>
    c.raiseDispute(1, 0, "Hash mismatch", { from: client, value: stake.toString() });

  // ── Core lifecycle (TC-01 … TC-17) ────────────────────────────────────
  it("TC-01 sets owner and response window on deploy", async () => {
    assert.equal(await c.owner(), owner);
    assert.equal((await c.responseWindow()).toNumber(), WINDOW);
  });

  it("TC-02 createProject locks ETH in contract", async () => {
    await makeProject();
    assert.equal(await web3.eth.getBalance(c.address), full);
  });

  it("TC-03 createProject reverts on wrong ETH amount", async () => {
    await expectRevert(
      c.createProject("App", "d", developer, arbitrator, ["M1"], [full], { from: client, value: half }),
      "ETH sent must equal"
    );
  });

  it("TC-04 createProject reverts if client = developer", async () => {
    await expectRevert(
      c.createProject("App", "d", client, arbitrator, ["M1"], [full], { from: client, value: full }),
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
    await expectRevert(
      c.submitMilestone(1, 0, hashA, "x", 1, { from: stranger }),
      "Not the developer"
    );
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

  it("TC-14 raising a dispute requires exactly a 5% stake", async () => {
    await makeProject();
    await submit();
    await expectRevert(
      c.raiseDispute(1, 0, "bad", { from: client, value: "1" }),
      "Must stake exactly 5%"
    );
    await disputeByClient();
    assert.equal((await c.getProject(1)).status.toNumber(), 2);
    assert.equal(BigInt(await web3.eth.getBalance(c.address)), BigInt(full) + stake);
  });

  it("TC-15 disputer (client) wins: client refunded 99.5%, stake back; developer's stake slashed", async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await c.respondToDispute(1, { from: developer, value: stake.toString() });

    const before = { client: await bal(client), arb: await bal(arbitrator) };
    await c.resolveDispute(1, false, { from: arbitrator });

    // client: milestone (minus 0.5%) + own stake
    assert.equal((await bal(client)) - before.client, BigInt(half) - platFee + stake);
    // platform: 0.5% fee + (slashed stake − arbitrator fee)
    assert.equal(BigInt(await c.platformBalance()), platFee + (stake - arbFee));
    const m = await c.getMilestone(1, 0);
    assert.equal(m.status.toNumber(), 5); // Refunded
    assert.equal((await c.getProject(1)).status.toNumber(), 0); // back to Active
  });

  it("TC-16 disputer (client) loses: developer paid, client's stake slashed, arbitrator gets 1%", async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await c.respondToDispute(1, { from: developer, value: stake.toString() });

    const devBefore = await bal(developer);
    const d = await delta(arbitrator, () => c.resolveDispute(1, true, { from: arbitrator }));

    assert.equal(d, arbFee);
    assert.equal((await bal(developer)) - devBefore, BigInt(half) - platFee + stake);
    assert.equal(BigInt(await c.platformBalance()), platFee + (stake - arbFee));
  });

  it("TC-17 client refunds project with no submitted milestones (no fee)", async () => {
    await makeProject();
    const d = await delta(client, () => c.refundClient(1, { from: client }));
    assert.equal(d, BigInt(full));
    assert.equal((await c.getProject(1)).status.toNumber(), 3);
  });

  // ── Staking / slashing edge cases ─────────────────────────────────────
  it("TC-18 arbitrator cannot rule before respondent counter-stakes", async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await expectRevert(c.resolveDispute(1, true, { from: arbitrator }), "Respondent has not staked");
  });

  it("TC-19 respondent must match the stake and respond in time", async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await expectRevert(c.respondToDispute(1, { from: developer, value: "1" }), "Must match");
    await expectRevert(c.respondToDispute(1, { from: stranger, value: stake.toString() }), "Not the respondent");
    await timeTravel(WINDOW + 1);
    await expectRevert(
      c.respondToDispute(1, { from: developer, value: stake.toString() }),
      "Response window closed"
    );
  });

  it("TC-20 disputer wins by default if respondent never stakes", async () => {
    await makeProject();
    await submit();
    await disputeByClient();
    await expectRevert(c.claimDefault(1, { from: client }), "window still open");
    await timeTravel(WINDOW + 1);
    const d = await delta(client, () => c.claimDefault(1, { from: client }));
    assert.equal(d, BigInt(half) - platFee + stake);
    assert.equal(BigInt(await c.platformBalance()), platFee); // nothing slashed
  });

  it("TC-21 developer can dispute a client who won't verify", async () => {
    await makeProject();
    await submit();
    await c.raiseDispute(1, 0, "Client ignoring delivery", { from: developer, value: stake.toString() });
    const dsp = await c.getDispute(1);
    assert.equal(dsp.respondent, client);
    await c.respondToDispute(1, { from: client, value: stake.toString() });
    const d = await delta(developer, () => c.resolveDispute(1, true, { from: arbitrator }));
    assert.equal(d, BigInt(half) - platFee + stake);
  });

  it("TC-22 refunded milestone cannot be resubmitted; project completes after remaining approval", async () => {
    await makeProject();
    await submit(0);
    await disputeByClient();
    await c.respondToDispute(1, { from: developer, value: stake.toString() });
    await c.resolveDispute(1, false, { from: arbitrator });
    await expectRevert(submit(0), "already submitted or settled");
    await submit(1);
    await c.verifyDeliverable(1, 1, hashA, { from: client });
    await c.approveMilestone(1, 1, { from: client });
    assert.equal((await c.getProject(1)).status.toNumber(), 1);
    assert.equal(BigInt(await c.getRemainingBalance(1)), 0n);
  });

  it("TC-23 contract balance always equals platform balance once everything settles; owner withdraws", async () => {
    await makeProject();
    await submit(0);
    await disputeByClient();
    await c.respondToDispute(1, { from: developer, value: stake.toString() });
    await c.resolveDispute(1, true, { from: arbitrator });
    await submit(1);
    await c.verifyDeliverable(1, 1, hashA, { from: client });
    await c.approveMilestone(1, 1, { from: client });

    const platform = BigInt(await c.platformBalance());
    assert.equal(BigInt(await web3.eth.getBalance(c.address)), platform);
    await expectRevert(c.withdrawPlatformFees({ from: stranger }), "Not the owner");
    const d = await delta(owner, () => c.withdrawPlatformFees({ from: owner }));
    assert.equal(d, platform);
    assert.equal(await web3.eth.getBalance(c.address), "0");
  });
});
