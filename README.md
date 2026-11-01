# MilestoneChain
<<<<<<< HEAD

Milestone escrow for software projects. ETH is released only after the client checks that the file they received has the same SHA-256 hash the developer registered on-chain. Disputes are staked: the loser pays.

- **Contract**: `contracts/MilestoneEscrow.sol` (Solidity 0.8.19, Truffle)
- **Tests**: `test/MilestoneEscrow.test.js` (23 tests)
- **Frontend**: `client/` (React + Vite + web3.js)

## Economic model

| What | Amount | Who pays / gets it |
|---|---|---|
| Platform fee | 0.5% of every milestone payout | Deducted from the payout (approval or dispute ruling) |
| Dispute stake | 5% of the milestone | Disputer stakes in `raiseDispute`; respondent matches in `respondToDispute` |
| Arbitrator fee | 1% of the milestone | Paid from the **loser's** slashed stake |
| Rest of slashed stake | 4% | Platform |
| Winner's stake | 5% | Returned in full |
| No response in time | — | Disputer calls `claimDefault`; wins with stake back, nobody slashed |
| Cancel/refund unused milestones | — | No fee |

Example for a 1 ETH milestone where the client disputes and loses: developer gets 0.995 + 0.05 (own stake back), arbitrator gets 0.01, platform gets 0.005 + 0.04.

## Run it

```bash
npm install
npm --prefix client install
```

Terminal 1, the local chain on port 7545 (or open Ganache GUI on port 7545):

```bash
npm run ganache
```

Terminal 2:

```bash
npm run migrate
npm test
npm run client
```

Open http://localhost:3000.

- **Ganache mode** (default) talks to Ganache directly and gives you one-click buttons to act as Platform, Client, Developer or Arbitrator (accounts 0–3). This is the easiest way to demo.
- **MetaMask mode**: add the network `http://127.0.0.1:7545` with chain ID `1337`, import the Ganache accounts, and switch accounts in MetaMask.

`npm run migrate` writes the ABI and deployed address into `client/src/contracts/`, so redeploying needs no frontend changes. Restarting Ganache wipes the chain, so run `npm run migrate` again after a restart.

The dispute response window is set in `migrations/1_deploy_milestone_escrow.js` (120 seconds for demos).

## Demo script

1. **Client**: create "E-Commerce App" with two 0.5 ETH milestones. The escrow now holds 1 ETH.
2. **Developer**: submit M0 by dropping `frontend.zip`. Its hash is registered on-chain.
3. **Client**: verify with the same file. The hashes match, so approve: the developer gets 0.4975 ETH and the platform gets 0.0025 ETH.
4. **Developer**: submit M1 with `backend.zip`.
5. **Client**: verify with a different file. The page shows a hash mismatch. Raise a dispute and stake 0.025 ETH.
6. **Developer**: counter-stake 0.025 ETH. Alternatively, wait 2 minutes and the client can claim a default win.
7. **Arbitrator**: the panel shows the payout for both outcomes. Rule for one side, and the loser's stake is split 1% to the arbitrator and the rest to the platform.
8. **Platform** (account 0): withdraw the accumulated fees.
9. **Client**: create a second project and use Cancel & refund before anything is submitted. The full amount comes back.
=======
Blockchain project
>>>>>>> 21905fb1a110af682b1c8411ce6c39394a30e0c9
