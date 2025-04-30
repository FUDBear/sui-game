import express from 'express';
import dotenv from 'dotenv';
import signer from './suiClient.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  console.log('[GET /] - Home route hit');
  res.send('Hello from Express + SUI!');
});

app.post('/play', async (req, res) => {
  const roll = Math.floor(Math.random() * 26);
  const success = roll > 22;

  console.log(`[POST /play] - Roll: ${roll} | Success: ${success}`);

  if (!success) {
    console.log('[POST /play] - User lost, responding with failure');
    return res.json({ win: false, roll });
  }

  try {
    console.log('[POST /play] - User won, calling SUI contract...');

    const tx = await signer.executeMoveCall({
      packageObjectId: '0xbc79c367fa197310390c7bd20535caf843c98e97a8e79855da4f5ff4abb6f4c1',
      module: 'simple_counter',
      function: 'reward_winner',
      typeArguments: [],
      arguments: [],
      gasBudget: 10000,
    });

    console.log('[POST /play] - Transaction success!');
    console.log(`[POST /play] - Transaction digest: ${tx.digest}`);

    res.json({
      win: true,
      roll,
      txDigest: tx.digest,
    });
  } catch (error) {
    console.error('[POST /play] - Failed to call contract:', error.message);
    res.status(500).json({
      error: 'Failed to call contract',
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
