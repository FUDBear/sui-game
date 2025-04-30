const express = require('express');
require('dotenv').config(); // To read .env file
const signer = require('./suiClient');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello from Express + SUI!');
});

app.post('/play', async (req, res) => {
  const roll = Math.floor(Math.random() * 26);
  const success = roll > 22;

  if (!success) {
    return res.json({ win: false, roll });
  }

  try {
    const tx = await signer.executeMoveCall({
      packageObjectId: '0xYOUR_PACKAGE_ID',
      module: 'your_module_name',
      function: 'reward_winner',
      typeArguments: [], // or e.g. ['0x2::sui::SUI']
      arguments: [],      // depends on your Move function
      gasBudget: 10000,
    });

    res.json({
      win: true,
      roll,
      txDigest: tx.digest,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to call contract',
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
