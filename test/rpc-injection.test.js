import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function schema() {
  const value = {
    default: () => value,
    role: () => value,
    volatile: () => value,
  }
  return value
}

async function loadHost() {
  const source = await readFile(join(root, 'index.js'), 'utf8')
  const executable = source
    .replace(/^import .*$/gm, '')
    .replace(/^export \{[^}]*\}$/gm, '')
    .replace(/^export /gm, '')
    + '\nglobalThis.__host = { apply, RPC_CHANNEL }\n'
  const context = {
    z: {
      object: schema,
      string: schema,
      array: schema,
      boolean: schema,
    },
    credentialRef: (value) => value,
    AttachmentId: (value) => value,
    defineTool: (definition) => definition,
    mkdir: async () => {},
    readFile: async () => { throw new Error('unexpected file read') },
    writeFile: async () => {},
    basename,
    dirname,
    extname,
    isAbsolute,
    join,
    resolve,
    Buffer,
  }
  vm.runInNewContext(executable, context, { filename: 'index.js' })
  return context.__host
}

function createHostContext() {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }

  function createScopedContext(dependencies) {
    let scoped
    const connection = {
      rpc: {
        handle(channel, handler) {
          // Mirror dsh-client-connection: rpc is scoped to the context that
          // read connection, and registration reads that owner's webServer.
          return scoped.effect(
            () => scoped.webServer.register({ kind: 'prefix', path: channel, handler }),
            `client-connection: ${channel} rpc channel`,
          )
        },
      },
    }
    scoped = new Proxy({
      get(name) {
        if (name === 'connection') return connection
        if (name === 'webServer') return webServer
        return undefined
      },
      effect(callback) {
        return callback()
      },
    }, {
      get(target, property, receiver) {
        if (property === 'connection' || property === 'webServer') {
          if (!dependencies.includes(property)) {
            throw new Error(`cannot get property "${property}" without inject`)
          }
          return property === 'connection' ? connection : webServer
        }
        return Reflect.get(target, property, receiver)
      },
    })
    return scoped
  }

  const ctx = {
    tools: { register: () => {} },
    inject(dependencies, callback) {
      // Settings and systemPrompt are optional for this regression. The
      // connection service is mounted and activates the RPC registration path.
      if (!dependencies.includes('connection')) return
      callback(createScopedContext(dependencies))
    },
  }
  return { ctx, routes }
}

test('RPC registration injects webServer into the connection owner context', async () => {
  const { apply, RPC_CHANNEL } = await loadHost()
  const { ctx, routes } = createHostContext()

  apply(ctx, {})

  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, RPC_CHANNEL)
  assert.equal(routes[0].kind, 'prefix')
})
