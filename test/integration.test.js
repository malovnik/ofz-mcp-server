import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

test('MCP: подключение, три инструмента, MOEX и защита входа', { timeout: 90000 }, async () => {
  const remote = process.env.TEST_ENDPOINT
  const endpoint = remote || 'http://127.0.0.1:19371/mcp'
  const base = new URL('./', endpoint).href
  let child
  const client = new Client({ name: 'ofz-release-check', version: '1.0.0' })
  try {
    if (!remote) {
      child = spawn(process.execPath, ['src/server.js'], {
        env: { ...process.env, HOST: '127.0.0.1', PORT: '19371' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(([code]) => { throw new Error(`Сервер завершился: ${code}`) }),
      ])
    }
    const health = await fetch(`${base}health`, { signal: AbortSignal.timeout(25000) })
    assert.equal(health.status, 200)
    const status = await health.json()
    assert.equal(status.status, 'ok')
    assert.ok(status.bonds > 0)
    assert.ok(status.ageSeconds <= 60)

    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)), { timeout: 25000 })
    assert.equal(client.getServerVersion().name, 'mosbirzha-bonds')
    assert.equal(client.getServerVersion().title, 'Мосбиржа — облигации')
    assert.match(client.getServerVersion().description, /MOEX ISS/)
    assert.match(client.getInstructions(), /флоатеров/)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['calculate_investment', 'get_bonds', 'get_issuers'])
    const bonds = await client.callTool({ name: 'get_bonds', arguments: { type: 'ofz', limit: 3 } })
    assert.ok(!bonds.isError)
    assert.match(bonds.content[0].text, /MOEX ISS/)
    assert.match(bonds.content[0].text, /SU\d{5}RMFS\d/)
    assert.match(bonds.content[0].text, /Найдено 3 облигаций/)
    assert.equal(bonds.structuredContent.bonds.length, 3)
    const floating = await client.callTool({ name: 'get_bonds', arguments: { ticker: 'SU29028RMFS6' } })
    assert.equal(floating.structuredContent.bonds[0].yieldKind, 'floating_coupon_estimate')
    assert.equal(floating.structuredContent.bonds[0].couponAmountKnown, false)
    assert.equal(floating.structuredContent.bonds[0].yieldSource, 'marketdata_yields.EFFECTIVEYIELD')
    const ticker = bonds.content[0].text.match(/SU\d{5}RMFS\d/)[0]
    const calculation = await client.callTool({ name: 'calculate_investment', arguments: { ticker, amount: 10000 } })
    assert.ok(!calculation.isError)
    assert.match(calculation.content[0].text, /Покупка/)
    const known = await client.callTool({ name: 'calculate_investment', arguments: { ticker: 'SU26238RMFS4', amount: 10000 } })
    assert.equal(known.structuredContent.status, 'known_cashflows')
    assert.ok(known.structuredContent.cashflows.coupons.length > 0)
    assert.match(known.structuredContent.scheduleSource.url, /bondization/)
    const issuers = await client.callTool({ name: 'get_issuers', arguments: {} })
    assert.ok(!issuers.isError)
    assert.match(issuers.content[0].text, /Сбербанк/)
    const invalid = await client.callTool({ name: 'get_bonds', arguments: { limit: -1 } })
    assert.equal(invalid.isError, true)
    const forbidden = await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://invalid.example', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) })
    assert.equal(forbidden.status, 403)
    const allowed = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://claude.ai', 'Access-Control-Request-Method': 'POST' }, signal: AbortSignal.timeout(10000) })
    assert.equal(allowed.status, 204)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://claude.ai')
    const invalidRest = await fetch(`${base}api/bonds?limit=-1`, { signal: AbortSignal.timeout(10000) })
    assert.equal(invalidRest.status, 400)
    console.log(JSON.stringify({ endpoint, bonds: status.bonds, fetchedAt: status.fetchedAt, tools: tools.tools.map(t => t.name), sample: bonds.content[0].text }))
  } finally {
    await client.close()
    if (child && child.exitCode === null) {
      const stopped = once(child, 'exit')
      child.kill('SIGTERM')
      await stopped
    }
  }
})
