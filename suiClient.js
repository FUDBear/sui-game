const { Ed25519Keypair, Connection, JsonRpcProvider, RawSigner } = require('@mysten/sui.js');

require('dotenv').config();
const mnemonic = process.env.SUI_MNEMONIC;

if (!mnemonic) {
  throw new Error('SUI_MNEMONIC is not set');
}

const keypair = Ed25519Keypair.deriveKeypair(mnemonic);
const connection = new Connection({
  fullnode: "https://fullnode.testnet.sui.io",
});
const provider = new JsonRpcProvider(connection);
const signer = new RawSigner(keypair, provider);

module.exports = signer;
