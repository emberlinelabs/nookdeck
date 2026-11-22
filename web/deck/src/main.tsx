import { mountDeck } from './mount'
import { migrateStorage } from './storage-migrate'

// Standalone page: the deck is always open. Other pages can load this bundle and call
// window.Nookdeck.mountDeck(el, { baseUrl }) to embed it as an overlay (window.PhoneDesk is the old name, kept as an alias).
const api = { mountDeck }
const w = window as unknown as { Nookdeck: typeof api; PhoneDesk: typeof api }
w.Nookdeck = api
w.PhoneDesk = api
migrateStorage()
mountDeck(document.getElementById('root') as HTMLElement, { standalone: true })
