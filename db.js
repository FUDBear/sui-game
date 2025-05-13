// db.js
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import path from 'path'

// 1) where should the file live?
const file = path.join(process.cwd(), 'db.json')

// 2) create the adapter
const adapter = new JSONFile(file)

// 3) supply your default data shape here as second arg
export const db = new Low(adapter, { players: {} })

// 4) on startup, read & write defaults if the file is empty
async function initDB() {
  await db.read()
  // after read, db.data will be your default ({ players: {} }) if file was missing/empty
  await db.write()
}

await initDB()
