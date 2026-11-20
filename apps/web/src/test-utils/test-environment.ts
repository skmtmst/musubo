import { afterAll, beforeEach } from 'vitest'
import { setTestReducedMotion } from './reduced-motion'
import { clearApiReadCache } from '../lib/api/transport/read-cache'
import { resetListUrlState } from '../components/shared/list-url-state'

// Vitest 4 only permits spying on functions. Happy DOM does not implement the
// native print/confirm dialogs, and Node 26 exposes an unusable localStorage
// without a backing file. Keep browser tests on isolated browser storage and
// require explicit spies for native dialogs rather than using Node globals.
if (typeof window !== 'undefined') {
  const { Storage } = await import('happy-dom')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  }
  install('localStorage', new Storage())
  install('sessionStorage', new Storage())
  for (const key of ['print', 'confirm']) {
    if (typeof Reflect.get(window, key) !== 'function') install(key, () => {
      throw new Error(`Native window.${key} must be explicitly mocked in a browser test`)
    })
  }
  afterAll(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
}

beforeEach(() => { setTestReducedMotion(true); clearApiReadCache(); resetListUrlState() })
