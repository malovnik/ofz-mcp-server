import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import cors from 'cors'
import * as z from 'zod'
import { fetchBonds, SAFE_ISSUERS } from './moexApi.js'

const app = express()
app.use(cors())
app.use(express.json())

// Кэш облигаций
let bondsCache = []
let lastFetch = 0
const CACHE_TTL = 60000 // 1 минута

async function getBondsData() {
  const now = Date.now()
  if (now - lastFetch > CACHE_TTL || bondsCache.length === 0) {
    try {
      bondsCache = await fetchBonds()
      lastFetch = now
    } catch (e) {
      console.error('Failed to fetch bonds:', e.message)
      if (bondsCache.length === 0) throw e
    }
  }
  return bondsCache
}

function formatDays(days) {
  if (days < 30) return `${days} дн.`
  if (days < 365) return `${Math.round(days / 30)} мес.`
  const years = Math.floor(days / 365)
  const months = Math.round((days % 365) / 30)
  return months > 0 ? `${years} г. ${months} мес.` : `${years} г.`
}

function getIssuerDescription(code) {
  const descriptions = {
    sber: 'Крупнейший банк России, контролируется ЦБ',
    vtb: 'Второй госбанк России, господдержка',
    gazprom: 'Крупнейшая газовая компания мира',
    rzd: 'Государственная монополия ж/д перевозок',
    rosneft: 'Крупнейшая нефтяная компания России',
    rostelecom: 'Государственный оператор связи',
    domrf: 'Институт развития жилья, госгарантии',
    rshb: 'Госбанк для АПК',
    fsk: 'Магистральные электросети',
    rosseti: 'Холдинг электросетей России',
    transneft: 'Монополия нефтепроводов',
    gtlk: 'Государственная лизинговая компания',
    rosatom: 'Госкорпорация атомной энергетики',
  }
  return descriptions[code] || 'Надёжный эмитент'
}

function createMcpServer() {
  const server = new McpServer({
    name: 'ofz-bonds',
    version: '1.0.0',
  })

  // Tool: Получить облигации с фильтрами
  server.registerTool(
    'get_bonds',
    {
      title: 'Get Bonds',
      description: 'Получить список облигаций ОФЗ, субфедеральных и корпоративных с фильтрами',
      inputSchema: {
        type: z.enum(['ofz', 'subfed', 'corp', 'all']).optional().default('all').describe('Тип облигаций'),
        max_months: z.number().optional().describe('Максимальный срок до погашения в месяцах'),
        min_yield: z.number().optional().describe('Минимальная доходность в процентах'),
        issuer: z.string().optional().describe('Код эмитента (sber, vtb, gazprom, rzd и др.)'),
        sort_by: z.enum(['yield', 'maturity', 'coupon']).optional().default('yield').describe('Сортировка'),
        limit: z.number().optional().default(20).describe('Лимит результатов'),
      },
    },
    async ({ type = 'all', max_months, min_yield, issuer, sort_by = 'yield', limit = 20 }) => {
      let bonds = await getBondsData()

      if (type !== 'all') bonds = bonds.filter(b => b.boardType === type)
      if (max_months) bonds = bonds.filter(b => b.daysToMaturity <= max_months * 30)
      if (min_yield) bonds = bonds.filter(b => b.yield && b.yield >= min_yield)
      if (issuer) bonds = bonds.filter(b => b.issuer?.code === issuer)

      bonds.sort((a, b) => {
        if (sort_by === 'yield') return (b.yield ?? 0) - (a.yield ?? 0)
        if (sort_by === 'maturity') return a.daysToMaturity - b.daysToMaturity
        if (sort_by === 'coupon') return b.couponValue - a.couponValue
        return 0
      })

      bonds = bonds.slice(0, limit)

      const result = bonds.map(b => ({
        name: b.shortName,
        ticker: b.secId,
        type: b.boardType,
        issuer: b.issuer?.name || (b.boardType === 'ofz' ? 'Минфин РФ' : null),
        price: b.price ? `${b.price.toFixed(2)}%` : null,
        yield: b.yield ? `${b.yield.toFixed(2)}%` : (b.secId.startsWith('SU29') ? '~RUONIA' : null),
        maturity: b.maturityDate?.toLocaleDateString('ru-RU'),
        daysToMaturity: b.daysToMaturity,
        coupon: b.couponValue ? `${b.couponValue.toFixed(2)} ₽` : null,
        nextCoupon: b.nextCouponDate?.toLocaleDateString('ru-RU'),
        nkd: b.accruedInt ? `${b.accruedInt.toFixed(2)} ₽` : null,
      }))

      return {
        content: [{
          type: 'text',
          text: `Найдено ${result.length} облигаций:\n\n${result.map((b, i) =>
            `${i + 1}. **${b.name}** (${b.ticker})\n` +
            `   Тип: ${b.type === 'ofz' ? 'ОФЗ' : b.type === 'subfed' ? 'Субфед' : 'Корп'}${b.issuer ? ` (${b.issuer})` : ''}\n` +
            `   Цена: ${b.price || '—'} | Доходность: ${b.yield || '—'}\n` +
            `   Погашение: ${b.maturity} (${formatDays(b.daysToMaturity)})\n` +
            `   Купон: ${b.coupon || '—'} | НКД: ${b.nkd || '—'}`
          ).join('\n\n')}`,
        }],
      }
    }
  )

  // Tool: Расчёт инвестиции
  server.registerTool(
    'calculate_investment',
    {
      title: 'Calculate Investment',
      description: 'Рассчитать доход от инвестиции в облигацию',
      inputSchema: {
        ticker: z.string().describe('Тикер облигации (например, SU26238RMFS4)'),
        amount: z.number().describe('Сумма инвестиции в рублях'),
      },
    },
    async ({ ticker, amount }) => {
      const bonds = await getBondsData()
      const bond = bonds.find(b => b.secId === ticker)

      if (!bond) return { content: [{ type: 'text', text: `Облигация ${ticker} не найдена` }] }
      if (!bond.price) return { content: [{ type: 'text', text: `Нет данных о цене для ${ticker}` }] }

      const pricePerBond = (bond.price / 100) * bond.faceValue + bond.accruedInt
      const quantity = Math.floor(amount / pricePerBond)
      const actualInvestment = quantity * pricePerBond
      const couponPeriodDays = bond.couponPeriod || 182
      const couponsPerYear = Math.round(365 / couponPeriodDays)
      const annualCouponIncome = quantity * bond.couponValue * couponsPerYear

      let totalCoupons = 0
      if (bond.nextCouponDate && bond.couponValue > 0) {
        const today = new Date()
        const daysToNextCoupon = Math.ceil((bond.nextCouponDate - today) / 86400000)
        if (daysToNextCoupon > 0 && daysToNextCoupon <= bond.daysToMaturity) {
          totalCoupons = 1 + Math.floor((bond.daysToMaturity - daysToNextCoupon) / couponPeriodDays)
        }
      }

      const totalCouponIncome = quantity * bond.couponValue * totalCoupons
      const maturityValue = quantity * bond.faceValue
      const totalProfit = maturityValue + totalCouponIncome - actualInvestment
      const isFloater = bond.secId.startsWith('SU29')

      const fmt = n => n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

      return {
        content: [{
          type: 'text',
          text: `## Расчёт: ${bond.shortName}\n\n` +
            `**Вложение:** ${fmt(amount)} ₽\n\n` +
            `### Покупка\n` +
            `- **${quantity} шт.** по ${pricePerBond.toFixed(2)} ₽\n` +
            `- Затраты: ${fmt(actualInvestment)} ₽\n\n` +
            (isFloater
              ? `### Флоатер\nКупон ~RUONIA. Доход зависит от ставки ЦБ.\n\n`
              : `### Доход\n` +
                `- Годовой: **+${fmt(annualCouponIncome)} ₽**\n` +
                `- Купонов до погашения: ${totalCoupons}\n` +
                `- Всего купонов: +${fmt(totalCouponIncome)} ₽\n\n`) +
            `### Погашение (${bond.maturityDate?.toLocaleDateString('ru-RU')})\n` +
            `- Номинал: ${fmt(maturityValue)} ₽\n` +
            (isFloater ? '' : `- **Прибыль: +${fmt(totalProfit)} ₽**`),
        }],
      }
    }
  )

  // Tool: Список эмитентов
  server.registerTool(
    'get_issuers',
    {
      title: 'Get Issuers',
      description: 'Получить список надёжных эмитентов корпоративных облигаций',
      inputSchema: {},
    },
    async () => {
      const issuersInfo = SAFE_ISSUERS.map(i => ({
        code: i.code,
        name: i.name,
        description: getIssuerDescription(i.code),
      }))

      return {
        content: [{
          type: 'text',
          text: `## Надёжные эмитенты\n\n` +
            issuersInfo.map(i => `- **${i.name}** (\`${i.code}\`): ${i.description}`).join('\n'),
        }],
      }
    }
  )

  return server
}

// MCP endpoint с Streamable HTTP
app.all('/mcp', async (req, res) => {
  try {
    const server = createMcpServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    res.on('close', () => {
      transport.close()
      server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    console.error('MCP error:', error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      })
    }
  }
})

// REST API для простого доступа
app.get('/api/bonds', async (req, res) => {
  try {
    const { type, max_months, min_yield, issuer, sort_by = 'yield', limit = 50 } = req.query
    let bonds = await getBondsData()

    if (type && type !== 'all') bonds = bonds.filter(b => b.boardType === type)
    if (max_months) bonds = bonds.filter(b => b.daysToMaturity <= Number(max_months) * 30)
    if (min_yield) bonds = bonds.filter(b => b.yield && b.yield >= Number(min_yield))
    if (issuer) bonds = bonds.filter(b => b.issuer?.code === issuer)

    bonds.sort((a, b) => {
      if (sort_by === 'yield') return (b.yield ?? 0) - (a.yield ?? 0)
      if (sort_by === 'maturity') return a.daysToMaturity - b.daysToMaturity
      if (sort_by === 'coupon') return b.couponValue - a.couponValue
      return 0
    })

    res.json({
      count: Math.min(bonds.length, Number(limit)),
      bonds: bonds.slice(0, Number(limit)).map(b => ({
        ticker: b.secId,
        name: b.shortName,
        type: b.boardType,
        issuer: b.issuer?.name,
        price: b.price,
        yield: b.yield,
        maturityDate: b.maturityDate?.toISOString().split('T')[0],
        daysToMaturity: b.daysToMaturity,
        couponValue: b.couponValue,
        nextCouponDate: b.nextCouponDate?.toISOString().split('T')[0],
        accruedInt: b.accruedInt,
        faceValue: b.faceValue,
      })),
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Health check
app.get('/health', async (_req, res) => {
  try {
    const bonds = await getBondsData()
    res.json({ status: 'ok', bonds: bonds.length, cached: Date.now() - lastFetch < CACHE_TTL })
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message })
  }
})

app.get('/', (_req, res) => {
  res.json({
    name: 'OFZ MCP Server',
    version: '1.0.0',
    endpoints: {
      mcp: '/mcp - Model Context Protocol endpoint',
      api: '/api/bonds - REST API для получения облигаций',
      health: '/health - Проверка состояния',
    },
    tools: ['get_bonds', 'calculate_investment', 'get_issuers'],
  })
})

const PORT = process.env.PORT || 3001

app.listen(PORT, () => {
  console.log(`OFZ MCP Server running on port ${PORT}`)
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`)
  console.log(`REST API: http://localhost:${PORT}/api/bonds`)

  // Preload bonds cache
  getBondsData().then(bonds => {
    console.log(`Loaded ${bonds.length} bonds`)
  }).catch(e => {
    console.error('Failed to preload bonds:', e.message)
  })
})
