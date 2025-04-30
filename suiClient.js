import dotenv from 'dotenv';
dotenv.config();

import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519.js';
import { RawSigner } from '@mysten/sui.js/dist/cjs/cryptography/raw-signer.js';
import { JsonRpcProvider, Connection } from '@mysten/sui.js/dist/cjs/providers/json-rpc-provider.js';

const keypair = Ed25519Keypair.deriveKeypair(process.env.SUI_MNEMONIC);
const connection = new Connection({
  fullnode: 'https://fullnode.testnet.sui.io',
});
const provider = new JsonRpcProvider(connection);
const signer = new RawSigner(keypair, provider);

export default signer;
