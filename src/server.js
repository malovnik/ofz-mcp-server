import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import cors from 'cors'
import * as z from 'zod'
import { fetchBonds, fetchPaymentSchedule, SAFE_ISSUERS } from './moexApi.js'
import { coverage, timing, selectBonds, publicBond, bondsText, calculateInvestment } from './bondData.js'

const info = {
  name: 'mosbirzha-bonds', title: 'Мосбиржа — облигации', version: '1.1.1',
  description: 'Облигации MOEX ISS: котировки, купоны, НКД, сроки, фильтры и календарь выплат. Источники и время каждого показателя. Только чтение, без ключа API. ' + coverage,
  websiteUrl: 'https://club.nikexpert.ru/mcp/moex/',
}
const instructions = `${coverage} ${timing} Суммы передаются в валюте выпуска; рублёвый расчёт запрещён для валютных выпусков без конвертации. Доходность флоатеров — расчётный показатель MOEX с предположениями, не фиксированный будущий доход. Не называй нулевой COUPONVALUE известным нулевым купоном, если couponAmountKnown=false. Доходность к оферте и индексируемого номинала выделяется отдельно. Список эмитентов не является рейтингом надёжности. Для итогов используй structuredContent и сохраняй примечания, источники и даты.`
const app = express()
app.disable('x-powered-by')
const origins = (process.env.ALLOWED_ORIGINS || 'https://claude.ai,https://chatgpt.com,https://club.nikexpert.ru').split(',')
app.use((req, res, next) => req.headers.origin && !origins.includes(req.headers.origin) ? res.status(403).json({ error: 'Недопустимый Origin' }) : next())
app.use(cors({ origin: origins, exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version'] }))
app.use(express.json({ limit: '64kb' }))

let bondsCache = []
let lastFetch = 0
let pendingFetch
const CACHE_TTL = 60000
const MAX_CACHE_AGE = 300000
async function getBondsData() {
  if (Date.now() - lastFetch >= CACHE_TTL || !bondsCache.length) {
    if (!pendingFetch) pendingFetch = fetchBonds().then(bonds => {
      if (!bonds.length) throw new Error('MOEX вернула пустой список облигаций')
      bondsCache = bonds
      lastFetch = Date.now()
    }).finally(() => { pendingFetch = undefined })
    try { await pendingFetch } catch (error) {
      console.error('MOEX:', error.message)
      if (!bondsCache.length || Date.now() - lastFetch > MAX_CACHE_AGE) throw error
    }
  }
  return bondsCache
}
const listInput = {
  type: z.enum(['ofz', 'subfed', 'corp', 'all']).optional().default('all'),
  max_months: z.number().positive().max(1200).optional(),
  min_yield: z.number().min(-100).max(1000).optional().describe('Минимальный показатель доходности MOEX. Учитывай yieldKind: флоатеры, индексация и оферты несопоставимы с фиксированным доходом.'),
  issuer: z.enum([...SAFE_ISSUERS.map(i => i.code), 'mo', 'msk']).optional(),
  ticker: z.string().regex(/^[A-Z0-9]{1,24}$/).optional().describe('Точный тикер для проверки конкретного выпуска'),
  coupon_type: z.enum(['all', 'known', 'floating', 'indexed', 'unknown']).optional().default('all'),
  currency: z.enum(['RUB', 'CNY', 'USD', 'EUR', 'CHF', 'all']).optional().default('RUB').describe('Валюта номинала; по умолчанию только RUB'),
  sort_by: z.enum(['yield', 'maturity', 'coupon']).optional().default('yield'),
  limit: z.number().int().min(1).max(200).optional().default(20),
}
const listSchema = z.object(listInput)
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
function response(data, text = JSON.stringify(data, null, 2)) {
  return { content: [{ type: 'text', text }], structuredContent: data }
}
async function listBonds(params) {
  const selected = selectBonds(await getBondsData(), params)
  return { source: 'MOEX ISS', fetchedAt: new Date(lastFetch).toISOString(), stale: Date.now() - lastFetch >= CACHE_TTL, coverage, timing,
    count: selected.bonds.length, totalMatching: selected.total, filters: params, bonds: selected.bonds.map(publicBond) }
}
function createMcpServer() {
  const server = new McpServer(info, { instructions })
  server.registerTool('get_bonds', {
    title: 'Облигации Мосбиржи', description: `Список облигаций с фильтрами, ценой, доходностью MOEX, купоном, НКД и происхождением полей. ${coverage} ${timing} Флоатеры помечены отдельно. По умолчанию RUB.`,
    inputSchema: listInput, annotations: readOnly,
  }, async params => {
    const data = await listBonds(params)
    return response(data, `Источник: MOEX ISS. Получено: ${data.fetchedAt}.\n${coverage}\n${timing}\n${data.stale ? 'Внимание: используются данные из кэша после ошибки обновления.\n' : ''}Найдено ${data.count} облигаций (всего по фильтрам ${data.totalMatching}):\n\n${bondsText(data.bonds)}`)
  })
  server.registerTool('calculate_investment', {
    title: 'Покупка и выплаты по облигации', description: 'Оценка покупки с НКД и размером лота. Для рублёвых выпусков с известными купонами — суммы по полному календарю MOEX с датами фиксации и погашениями. Для флоатеров, индексации, валюты, оферты и неполных данных не выдумывает прибыль. Комиссии и налоги не включены.',
    inputSchema: { ticker: z.string().regex(/^[A-Z0-9]{1,24}$/), amount: z.number().positive().max(1e12).describe('Бюджет в рублях') }, annotations: readOnly,
  }, async ({ ticker, amount }) => {
    const bond = (await getBondsData()).find(b => b.secId === ticker)
    if (!bond) return { isError: true, content: [{ type: 'text', text: `Выпуск ${ticker} не найден в описанной выборке. ${coverage}` }] }
    let schedule
    let scheduleError
    if (bond.couponKind === 'known' && bond.faceCurrency === 'RUB' && bond.settlementCurrency === 'RUB') {
      try { schedule = await fetchPaymentSchedule(ticker) } catch (error) { scheduleError = error.message }
    }
    const result = calculateInvestment(bond, amount, schedule)
    if (scheduleError) result.reason = `Календарь MOEX недоступен: ${scheduleError}. Покупка оценена, общая прибыль не рассчитана.`
    result.stale = Date.now() - lastFetch >= CACHE_TTL
    return response(result, `Покупка и выплаты: ${bond.shortName}\n${JSON.stringify(result, null, 2)}`)
  })
  server.registerTool('get_issuers', {
    title: 'Эмитенты в выборке', description: 'Справочник поддерживаемых кодов эмитентов. Это перечень для фильтрации, без рейтинга надёжности и рекомендаций покупать.',
    inputSchema: {}, annotations: readOnly,
  }, async () => response({ coverage, note: 'Наличие в справочнике не означает надёжность или государственную гарантию.', issuers: [...SAFE_ISSUERS.map(({ code, name }) => ({ code, name })), { code: 'msk', name: 'Москва' }, { code: 'mo', name: 'Московская область' }] }))
  return server
}
app.all('/mcp', async (req, res) => {
  const server = createMcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { void transport.close(); void server.close() })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    console.error('MCP:', error.message)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Ошибка сервера' }, id: null })
  }
})
app.get('/api/bonds', async (req, res) => {
  const query = { ...req.query }
  for (const key of ['max_months', 'min_yield', 'limit']) if (query[key] !== undefined && typeof query[key] === 'string' && query[key].trim()) query[key] = Number(query[key])
  const parsed = listSchema.safeParse(query)
  if (!parsed.success) return res.status(400).json({ error: 'Некорректные фильтры', details: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) })
  try { res.json(await listBonds(parsed.data)) } catch (error) { res.status(503).json({ error: error.message }) }
})
app.get('/health', async (_req, res) => {
  try {
    const bonds = await getBondsData()
    const age = Date.now() - lastFetch
    res.status(age < CACHE_TTL ? 200 : 503).json({ status: age < CACHE_TTL ? 'ok' : 'degraded', version: info.version, bonds: bonds.length, cached: age < CACHE_TTL, fetchedAt: new Date(lastFetch).toISOString(), ageSeconds: Math.round(age / 1000) })
  } catch (error) { res.status(503).json({ status: 'error', message: error.message }) }
})
app.get('/', (_req, res) => res.json({ ...info, instructions, endpoints: { mcp: '/mcp', api: '/api/bonds', health: '/health' } }))
const PORT = process.env.PORT || 3001
const HOST = process.env.HOST || '127.0.0.1'
const listener = app.listen(PORT, HOST, () => {
  console.log(`${info.title} ${info.version}: ${HOST}:${PORT}`)
  getBondsData().then(bonds => console.log(`MOEX: ${bonds.length} облигаций`)).catch(error => console.error('MOEX:', error.message))
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  listener.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 20000).unref()
})
