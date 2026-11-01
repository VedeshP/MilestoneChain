const path = require("path");

module.exports = {
  // ABI + deployed address are written straight into the React app
  contracts_build_directory: path.join(__dirname, "client/src/contracts"),

  networks: {
    // Ganache GUI (default port 7545) or `npm run ganache`
    development: { host: "127.0.0.1", port: 7545, network_id: "*" },
    // Throwaway chain for tests so they do not clutter the Ganache app (npm run ganache:test, then npm run test:cli)
    test: { host: "127.0.0.1", port: 8545, network_id: "*" },
  },

  compilers: {
    solc: {
      version: "0.8.19",
      settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
    },
  },
};
