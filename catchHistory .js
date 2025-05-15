import fs from 'fs/promises';
import path from 'path';

const historyFile = path.join(process.cwd(), 'catchHistory.json');

// whenever you push a new record:
unclaimedCatches.push(catchRecord);
catchHistory.push(catchRecord);

// then…
await fs.writeFile(historyFile,
  JSON.stringify(catchHistory, null, 2),
  'utf8'
);
