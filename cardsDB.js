import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import path from 'path'

const file = path.join(process.cwd(), 'cards.json')
const adapter = new JSONFile(file)

export const cardsDb = new Low(adapter, { cards: {} })

await cardsDb.read()
