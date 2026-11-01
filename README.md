# MilestoneChain

Milestone escrow for software projects. ETH is released only after the client checks that the file they received has the same SHA-256 hash the developer registered on-chain. Disputes are staked (the loser pays) and decided by a panel of 3 bonded arbitrators.

- **Contract**: `contracts/MilestoneEscrow.sol` (Solidity 0.8.19, Truffle)
- **Tests**: `test/MilestoneEscrow.test.js` (27 tests)
- **Frontend**: `client/` (React + Vite + web3.js)

## Economic model

| What | Amount | Who pays / gets it |
|---|---|---|
| Platform fee | 0.5% of every milestone payout | Deducted from the payout (approval or dispute ruling) |
| Dispute stake | 5% of the milestone | Disputer stakes in `raiseDispute`; respondent matches in `respondToDispute` |
| Arbitrator fee | 1% of the milestone | Paid from the **loser's** slashed stake, split between arbitrators who voted for the outcome |
| Rest of slashed stake | 4% | Platform |
| Winner's stake | 5% | Returned in full |
| No response in time | — | Disputer calls `claimDefault`; wins with stake back, nobody slashed |
| Cancel/refund unused milestones | — | No fee |

Example for a 1 ETH milestone where the client disputes and loses: the developer gets 0.995 plus 0.05 (their own stake back), the 2 majority arbitrators get 0.005 each, and the platform gets 0.005 + 0.04.

## Arbitrator panel: why arbitrators stay honest

A single arbitrator gets paid whichever way they rule, so nothing stops them cheating. Instead:

1. **Bond to join.** Each arbitrator locks **1 ETH** with `joinPanel()`. There are 3 seats. The migration registers Ganache accounts 3, 4 and 5.
2. **Every dispute goes to all 3.** The panel is copied into the dispute when it is raised. Parties can't pick their own arbitrator, and an arbitrator can't be the client or developer.
3. **2 matching votes decide.** `vote()` settles the dispute automatically on the second matching vote.
4. **Slashing.** An arbitrator who votes against the final outcome loses **0.1 ETH** of their bond to the platform. One who doesn't vote before the deadline loses the same, when the dispute times out.
5. **Removal.** When a bond falls below **0.5 ETH**, the arbitrator is removed from the panel and gets the rest back. `leavePanel()` returns the full bond if they have no open cases.
6. **No majority in time.** Anyone can call `finalizeDispute()`, and the **respondent wins**, because the disputer has to convince the panel.

To cheat, two arbitrators would have to collude. A lone cheater loses money.

Known limitations, worth mentioning in the report:
- **Votes are public.** The third arbitrator can see the first two votes and copy them. The fix is commit-reveal voting (submit a hash of the vote, reveal later).
- **The panel is fixed, not randomly drawn.** Blockchains are deterministic, so there is no safe on-chain randomness. Real systems use an oracle such as Chainlink VRF.

## Run it

```bash
npm install
npm --prefix client install
```

1. Open the **Ganache app** and click Quickstart (port 7545). Make sure the accounts show 100 ETH each. Alternatively, run `npm run ganache`, but **never run both at once**: they share port 7545.
2. Deploy, which also registers the 3 arbitrators:

```bash
npm run migrate
```

3. Start the UI and open http://localhost:3000:

```bash
npm run client
```

Run `npm run migrate` again whenever Ganache restarts or the contract changes.

Tests run on a separate chain on port 8545, so they don't clutter the Ganache app. Start that chain in one terminal:

```bash
npm run ganache:test
```

Then run the tests in another:

```bash
npm run test:cli
```

- **Ganache mode** (default) gives one-click buttons for Platform, Client, Developer and Arbitrator 1–3 (accounts 0–5).
- **MetaMask mode**: add the network `http://127.0.0.1:7545` with chain ID `1337`, import the Ganache accounts, and switch accounts in MetaMask.

`npm run migrate` writes the ABI and deployed address into `client/src/contracts/`, so redeploying needs no frontend changes. The dispute response and voting window is set in `migrations/1_deploy_milestone_escrow.js` (120 seconds for demos).

## Demo script

1. **Client**: create "E-Commerce App" with two 0.5 ETH milestones. The escrow now holds 1 ETH plus the 3 ETH of arbitrator bonds.
2. **Developer**: submit M0 by dropping `frontend.zip`. Its hash is registered on-chain.
3. **Client**: verify with the same file. The hashes match, so approve: the developer gets 0.4975 ETH and the platform gets 0.0025 ETH.
4. **Developer**: submit M1 with `backend.zip`.
5. **Client**: verify with a different file. The page shows a hash mismatch. Raise a dispute and stake 0.025 ETH.
6. **Developer**: counter-stake 0.025 ETH. Alternatively, wait 2 minutes and the client can claim a default win.
7. **Arbitrator 3** votes for the Client. **Arbitrators 1 and 2** vote for the Developer. The second vote settles it: the client's stake is slashed, Arbitrators 1 and 2 get 0.0025 ETH each, and Arbitrator 3's bond drops to 0.9 ETH.
8. **Platform** (account 0): withdraw the accumulated fees.
9. **Client**: create a second project and use Cancel & refund before anything is submitted. The full amount comes back.
