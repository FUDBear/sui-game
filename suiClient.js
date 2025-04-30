import dotenv from 'dotenv';
import { Ed25519Keypair, RawSigner, Connection, JsonRpcProvider } from '@mysten/sui.js';

dotenv.config();

const keypair = Ed25519Keypair.deriveKeypair(process.env.SUI_MNEMONIC);
const connection = new Connection({
  fullnode: 'https://fullnode.testnet.sui.io',
});
const provider = new JsonRpcProvider(connection);
const signer = new RawSigner(keypair, provider);

export default signer;
