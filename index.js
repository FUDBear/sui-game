const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello from Express on Render!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const signer = require('./suiClient');

app.post('/play', async (req, res) => {
  const roll = Math.floor(Math.random() * 26);
  const success = roll > 22;

  if (success) {
    try {
      const tx = await signer.executeMoveCall({
        packageObjectId: '0x...',
        module: 'game',
        function: 'reward_winner',
        typeArguments: [],
        arguments: [], // Your contract args
        gasBudget: 10000,
      });

      return res.json({ win: true, txDigest: tx.digest, roll });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to send transaction', details: err.message });
    }
  }

  res.json({ win: false, roll });
});
