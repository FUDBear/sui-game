import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import path from 'path'

const file = path.join(process.cwd(), 'fish.json')
const adapter = new JSONFile(file)

export const fishDb = new Low(adapter, { fish: {} })

await fishDb.read()
