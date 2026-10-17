import assert from 'assert'
import {ServiceFactory} from '../service-factory'
import {ITab} from './check-tab'

describe('Service factory registry startup', () => {
  const globalNames = ['chrome', 'PRODUCTION', 'self'] as const
  let originalGlobals: (PropertyDescriptor | undefined)[]
  let windowsCalls: number
  let getWindows: () => Promise<chrome.windows.Window[]>
  const tab = {id: 1, windowId: 1, url: 'https://example.com', active: true} as ITab
  const windows = [{tabs: [tab]}] as chrome.windows.Window[]

  beforeEach(() => {
    originalGlobals = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
    Object.assign(ServiceFactory, {
      settingsCache: undefined,
      registryCache: undefined,
      registryInitialization: undefined,
    })
    windowsCalls = 0
    getWindows = async () => windows
    Object.defineProperties(globalThis, {
      PRODUCTION: {configurable: true, writable: true, value: true},
      self: {configurable: true, writable: true, value: globalThis},
      chrome: {
        configurable: true,
        writable: true,
        value: {
          storage: {local: {get: async () => ({}), set: async () => {}}},
          windows: {
            getAll: () => {
              windowsCalls += 1
              return getWindows()
            },
          },
          scripting: {executeScript: async () => []},
        },
      },
    })
  })

  afterEach(() => {
    Object.assign(ServiceFactory, {
      settingsCache: undefined,
      registryCache: undefined,
      registryInitialization: undefined,
    })
    globalNames.forEach((name, index) => {
      const descriptor = originalGlobals[index]
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        Reflect.deleteProperty(globalThis, name)
      }
    })
  })

  it('shares one registry between concurrent cold-start callers and later callers', async () => {
    let resolveWindows!: (value: chrome.windows.Window[]) => void
    const windowsPromise = new Promise<chrome.windows.Window[]>((resolve) => {
      resolveWindows = resolve
    })
    getWindows = () => windowsPromise
    const first = ServiceFactory.getTabRegistry()
    const second = ServiceFactory.getTabRegistry()
    // Both callers must already be waiting while the browser response is pending.
    resolveWindows(windows)
    const [firstRegistry, secondRegistry] = await Promise.all([first, second])
    assert.strictEqual(firstRegistry, secondRegistry)
    assert.strictEqual(await ServiceFactory.getTabRegistry(), firstRegistry)
    assert.strictEqual(windowsCalls, 1)
  })

  it('delivers readiness through a concurrent caller to the registry waiting for initialization', async () => {
    const [commandRegistry, messageRegistry] = await Promise.all([
      ServiceFactory.getTabRegistry(),
      ServiceFactory.getTabRegistry(),
    ])
    const initialization = commandRegistry.startInitialization(tab)
    messageRegistry.addToInitialized(tab)
    try {
      assert.strictEqual(await initialization.promise, true)
      assert.ok(commandRegistry.isInitialized(tab))
    } finally {
      initialization.resolver(false)
    }
  })

  it('rejects all concurrent waiters on bootstrap failure and retries on the next call', async () => {
    const error = new Error('Browser tab query failed')
    let rejectWindows!: (reason: Error) => void
    const windowsPromise = new Promise<chrome.windows.Window[]>((_resolve, reject) => {
      rejectWindows = reject
    })
    getWindows = () => windowsPromise
    const first = ServiceFactory.getTabRegistry()
    const second = ServiceFactory.getTabRegistry()
    const resultsPromise = Promise.allSettled([first, second])
    rejectWindows(error)
    const results = await resultsPromise
    results.forEach((result) => {
      assert.strictEqual(result.status, 'rejected')
      if (result.status === 'rejected') {
        assert.strictEqual(result.reason, error)
      }
    })
    assert.strictEqual(windowsCalls, 1)

    getWindows = async () => windows
    const registry = await ServiceFactory.getTabRegistry()
    assert.strictEqual(registry.getActive()?.id, tab.id)
    assert.strictEqual(await ServiceFactory.getTabRegistry(), registry)
    assert.strictEqual(windowsCalls, 2)
  })
})
