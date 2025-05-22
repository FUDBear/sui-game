// suiClient.js
import dotenv from 'dotenv';
dotenv.config();

import { SuiClient, getFullnodeUrl }          from '@mysten/sui/client';
import { Ed25519Keypair }                     from '@mysten/sui/keypairs/ed25519';
import { Transaction }                        from '@mysten/sui/transactions';
import { getFaucetHost, requestSuiFromFaucetV1 } from '@mysten/sui/faucet';
import { MIST_PER_SUI }                       from '@mysten/sui/utils';

const NETWORK    = process.env.SUI_NETWORK;
const RPC_URL    = getFullnodeUrl(NETWORK);
const FAUCET_URL = getFaucetHost(NETWORK);

export const client  = new SuiClient({ url: RPC_URL });
export const keypair = Ed25519Keypair.deriveKeypair(process.env.SUI_MNEMONIC);
export const address = keypair.getPublicKey().toSuiAddress();

const MODULE = "testnet_nft";
const ENTRY_FN = "mint_to_sender";
const PACKAGE_ID = "0x1e479bcb9de55ccf9194200d810d35426ba81dff86467b4ac66f802687b93243";
const ENTRY_TO  = "mint_to";


// No real SDK calls for now—just stubbed
export async function fundIfNeeded() {
  // no-op until contract is deployed
}

export async function callRewardWinner() {
  // Simulate on-chain latency
  await new Promise((r) => setTimeout(r, 300));

  // Return fake transaction result
  return {
    digest: '0x' + Math.floor(Math.random() * 1e16).toString(16),
    effects: { status: 'success', gasUsed: 1000 },
    events: [{ type: 'DummyEvent', data: { won: true } }],
  };
}

export async function mintNFT({ name, description, imageUrl, thumbnailUrl }) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::${MODULE}::${ENTRY_FN}`,
    arguments: [
      tx.pure.string(name),
      tx.pure.string(description),
      tx.pure.string(imageUrl),
      tx.pure.string(thumbnailUrl),
    ],
  });
  tx.setSender(address);
  const { bytes, signature } = await tx.sign({ client, signer: keypair });
  return await client.executeTransactionBlock({ transactionBlock: bytes, signature });
}

export async function transferNFT(objectId, recipientAddress) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::${MODULE}::transfer`,
    arguments: [
      tx.pure.object(objectId),
      tx.pure.address(recipientAddress),
    ],
  });
  tx.setSender(address);
  const { bytes, signature } = await tx.sign({ client, signer: keypair });
  return client.executeTransactionBlock({ transactionBlock: bytes, signature });
}

export async function mintNFTTo({ recipient, name, description, imageUrl, thumbnailUrl }) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${process.env.PACKAGE_ID}::${MODULE}::${ENTRY_TO}`,
    arguments: [
      tx.pure.address(recipient),
      tx.pure.string(name),
      tx.pure.string(description),
      tx.pure.string(imageUrl),
      tx.pure.string(thumbnailUrl),
    ],
  });
  tx.setSender(address);
  const { bytes, signature } = await tx.sign({ client, signer: keypair });
  return client.executeTransactionBlock({ transactionBlock: bytes, signature });
}