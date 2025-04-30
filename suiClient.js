// suiClient.js
import dotenv from 'dotenv';
dotenv.config();

import { SuiClient, getFullnodeUrl }          from '@mysten/sui/client';
import { Ed25519Keypair }                     from '@mysten/sui/keypairs/ed25519';
import { Transaction }                        from '@mysten/sui/transactions';
import { getFaucetHost, requestSuiFromFaucetV1 } from '@mysten/sui/faucet';
import { MIST_PER_SUI }                       from '@mysten/sui/utils';

const NETWORK    = process.env.SUI_NETWORK;                 // "testnet"
const RPC_URL    = getFullnodeUrl(NETWORK);                 // https://fullnode.testnet.sui.io
const FAUCET_URL = getFaucetHost(NETWORK);                  // https://faucet.testnet.sui.io

export const client  = new SuiClient({ url: RPC_URL });
export const keypair = Ed25519Keypair.deriveKeypair(process.env.SUI_MNEMONIC);
export const address = keypair.getPublicKey().toSuiAddress();

// Top up to 1 SUI if below threshold
export async function fundIfNeeded() {
  const { totalBalance } = await client.getBalance({ owner: address });
  const sui = Number(totalBalance) / MIST_PER_SUI;
  if (sui < 1) {
    await requestSuiFromFaucetV1({ host: FAUCET_URL, recipient: address });
  }
}

// Build, sign, and execute your Move call
export async function callRewardWinner() {
  await fundIfNeeded();

  const tx = new Transaction();
  tx.moveCall({
    target: `${process.env.PACKAGE_ID}::simple_counter::reward_winner`,
    arguments: [],
  });

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });

  return result;
}
