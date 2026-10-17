import assert from 'assert'
import {afterEach, beforeEach, describe, it} from 'mocha'
import {ITab} from './check-tab'
import TabRegistry from './tab-registry'

describe('Tab initialization', () => {
  const tab = {id: 1, windowId: 1, url: 'https://example.test'} as ITab
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>()
  let timers: Map<number, {callback: () => void; delay: number}>
  let executeScript: () => Promise<unknown>
  let injectionCount: number

  function setGlobal(name: string, value: unknown) {
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value})
  }

  beforeEach(() => {
    for (const name of ['chrome', 'self', 'PRODUCTION', 'clearTimeout']) {
      originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    }
    const originalClearTimeout = clearTimeout
    timers = new Map()
    let nextTimerId = 0
    injectionCount = 0
    executeScript = async () => []
    setGlobal('PRODUCTION', true)
    setGlobal('self', {
      setTimeout(callback: () => void, delay: number) {
        const id = ++nextTimerId
        timers.set(id, {callback, delay})
        return id
      },
    })
    setGlobal('clearTimeout', (id: Parameters<typeof clearTimeout>[0]) => {
      if (typeof id === 'number' && timers.delete(id)) {
        return
      }
      originalClearTimeout(id)
    })
    setGlobal('chrome', {
      scripting: {
        executeScript() {
          injectionCount += 1
          return executeScript()
        },
      },
    })
  })

  afterEach(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        Reflect.deleteProperty(globalThis, name)
      }
    }
  })

  function fireTimeout(id: number) {
    const timer = timers.get(id)
    assert.ok(timer)
    timers.delete(id)
    timer!.callback()
  }

  it('cleans up a successful initialization and its timeout', async () => {
    const registry = new TabRegistry()
    const initialization = registry.startInitialization(tab)

    assert.strictEqual(timers.get(initialization.timeout)!.delay, 400)
    registry.addToInitialized(tab)

    assert.strictEqual(await initialization.promise, true)
    assert.strictEqual(registry.tabInitializations.has(tab.id), false)
    assert.strictEqual(timers.size, 0)
    assert.strictEqual(injectionCount, 1)
  })

  it('allows a fresh injection after an initialization times out', async () => {
    const registry = new TabRegistry()
    const first = registry.startInitialization(tab)
    fireTimeout(first.timeout)

    assert.strictEqual(await first.promise, false)
    assert.strictEqual(registry.tabInitializations.has(tab.id), false)

    const retry = registry.startInitialization(tab)
    registry.addToInitialized(tab)

    assert.strictEqual(await retry.promise, true)
    assert.strictEqual(injectionCount, 2)
    assert.strictEqual(timers.size, 0)
  })

  it('clears a rejected injection and allows a retry', async () => {
    executeScript = async () => {
      throw new Error('injection failed')
    }
    const registry = new TabRegistry()
    const first = registry.startInitialization(tab)

    assert.strictEqual(await first.promise, false)
    assert.strictEqual(registry.tabInitializations.has(tab.id), false)
    assert.strictEqual(timers.size, 0)

    executeScript = async () => []
    const retry = registry.startInitialization(tab)
    registry.addToInitialized(tab)

    assert.strictEqual(await retry.promise, true)
    assert.strictEqual(injectionCount, 2)
  })

  it('clears a synchronous injection error and allows a retry', async () => {
    executeScript = () => {
      throw new Error('invalid injection target')
    }
    const registry = new TabRegistry()
    const first = registry.startInitialization(tab)

    assert.strictEqual(await first.promise, false)
    assert.strictEqual(registry.tabInitializations.has(tab.id), false)
    assert.strictEqual(timers.size, 0)

    executeScript = async () => []
    const retry = registry.startInitialization(tab)
    registry.addToInitialized(tab)

    assert.strictEqual(await retry.promise, true)
    assert.strictEqual(injectionCount, 2)
  })

  it('does not let a late rejection clear a newer initialization', async () => {
    let rejectFirst: (error: Error) => void = () => {}
    executeScript = () => new Promise((_resolve, reject) => {
      rejectFirst = reject
    })
    const registry = new TabRegistry()
    const first = registry.startInitialization(tab)
    fireTimeout(first.timeout)
    assert.strictEqual(await first.promise, false)

    executeScript = async () => []
    const retry = registry.startInitialization(tab)
    rejectFirst(new Error('old injection failed late'))
    await Promise.resolve()

    assert.strictEqual(registry.tabInitializations.get(tab.id), retry)
    registry.addToInitialized(tab)
    assert.strictEqual(await retry.promise, true)
    assert.strictEqual(timers.size, 0)
  })

  it('does not let an already completed resolver clear a newer initialization', async () => {
    const registry = new TabRegistry()
    const first = registry.startInitialization(tab)
    registry.addToInitialized(tab)
    assert.strictEqual(await first.promise, true)
    registry.removeFromInitialized(tab.id)

    const retry = registry.startInitialization(tab)
    first.resolver(false)

    assert.strictEqual(registry.tabInitializations.get(tab.id), retry)
    registry.addToInitialized(tab)
    assert.strictEqual(await retry.promise, true)
    assert.strictEqual(timers.size, 0)
  })
})
