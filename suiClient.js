import dotenv from 'dotenv';
dotenv.config();

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair }            from '@mysten/sui/keypairs/ed25519';
import { Transaction }               from '@mysten/sui/transactions';

const NETWORK    = process.env.SUI_NETWORK;
const RPC_URL    = getFullnodeUrl(NETWORK);
export const client = new SuiClient({ url: RPC_URL });

export const keypair = Ed25519Keypair.deriveKeypair(process.env.SUI_MNEMONIC);
export const address = keypair.getPublicKey().toSuiAddress();

const PACKAGE_ID = "0x1e479bcb9de55ccf9194200d810d35426ba81dff86467b4ac66f802687b93243";
const MODULE     = "testnet_nft";
const ENTRY_TS   = "mint_to_sender";
const ENTRY_TO   = "mint_to";

// mint to yourself (sender)
export async function mintNFT({ name, description, imageUrl, thumbnailUrl }) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::${MODULE}::${ENTRY_TS}`,
    arguments: [
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

// 🔥 NEW: mint _to_ an arbitrary address
export async function mintNFTTo(recipientAddress, { name, description, imageUrl, thumbnailUrl }) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::${MODULE}::${ENTRY_TO}`,
    arguments: [
      tx.pure.address(recipientAddress),
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