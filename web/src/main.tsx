import {Buffer} from 'buffer'
;(globalThis as any).Buffer ??= Buffer
import {createRoot} from 'react-dom/client'
import '@solana/wallet-adapter-react-ui/styles.css'
import './styles.css'
import {Root} from './App'

createRoot(document.getElementById('root')!).render(<Root />)
