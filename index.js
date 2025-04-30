// index.js
import express from 'express';
import dotenv from 'dotenv';
import { client, address, mintNFT, callRewardWinner } from './suiClient.js';
import cors from 'cors';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cors());

import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/balance', async (_, res) => {
  try {
    const { totalBalance } = await client.getBalance({ owner: address }); // BigInt
    const balanceSui = Number(totalBalance) / 1e9;  // mist → SUI
    res.json({ address, balanceSui });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /play → roll & call Move on win
app.post('/play', async (_, res) => {
  const roll = Math.floor(Math.random() * 26);
  const win  = roll > 22;

  if (!win) {
    return res.json({ win: false, roll });
  }

  try {
    const tx = await callRewardWinner();
    res.json({
      win: true,
      roll,
      txDigest: tx.digest,
      effects: tx.effects,
      events: tx.events,
    });
  } catch (err) {
    console.error('Contract call failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`Testnet address: ${address}`);
});

app.get('/', (_, res) => {
  res.send(`
    <h1>SUI Game API</h1>
    <ul>
      <li><a href="/balance">/balance</a> – your Testnet balance</li>
      <li><a href="/play" onclick="fetch('/play',{method:'POST'}).then(r=>r.json()).then(j=>alert(JSON.stringify(j)))">/play</a> – play the game</li>
    </ul>
  `);
});

app.post('/mint', async (req, res) => {
  try {
    const { name, description, imageUrl, thumbnailUrl } = req.body;

    const result = await mintNFT({
      name,
      description,
      imageUrl,
      thumbnailUrl,
    });

    res.json({
      success: true,
      digest: result.digest,
      objectChanges: result.objectChanges,
    });
  } catch (err) {
    console.error('NFT minting failed:', err);
    res.status(500).json({ error: err.message });
  }
});