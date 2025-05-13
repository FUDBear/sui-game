// fishDb.js
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import path from 'path'

// Point at your fish.json file
const file = path.join(process.cwd(), 'fish.json')
const adapter = new JSONFile(file)

// Supply an empty default so lowdb won’t crash if the file is missing
export const fishDb = new Low(adapter, { fish: {} })

// Read the file on startup (populates fishDb.data)
await fishDb.read()
