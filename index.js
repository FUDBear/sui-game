import express from 'express';
import dotenv from 'dotenv';
import { client, address } from './suiClient.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/balance', async (_, res) => {
  try {
    const { totalBalance } = await client.getBalance({ owner: address });
    res.json({
      address,
      balanceSui: Number(totalBalance) / 1e9  // mist → SUI
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on http://localhost:${PORT}`);
  console.log(`Your Testnet address is ${address}`);
});
