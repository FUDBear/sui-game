import dotenv from 'dotenv';
dotenv.config();

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const NETWORK  = 'testnet';
const RPC_URL  = getFullnodeUrl(NETWORK);     // https://fullnode.testnet.sui.io
export const client  = new SuiClient({ url: RPC_URL });

export const keypair = Ed25519Keypair.deriveKeypair(
  process.env.SUI_MNEMONIC
);
export const address = keypair.getPublicKey().toSuiAddress();
