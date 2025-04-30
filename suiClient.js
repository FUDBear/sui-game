require('dotenv').config();
const { Ed25519Keypair, RawSigner, Connection, JsonRpcProvider } = require('@mysten/sui.js');

const keypair = Ed25519Keypair.deriveKeypair(process.env.SUI_MNEMONIC);
const provider = new JsonRpcProvider(new Connection({
  fullnode: 'https://fullnode.testnet.sui.io',
}));
const signer = new RawSigner(keypair, provider);

module.exports = signer;
