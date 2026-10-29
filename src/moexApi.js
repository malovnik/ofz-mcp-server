const MOEX_OFZ_URL =
  'https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQOB/securities.json?iss.meta=off'

const MOEX_CORP_URL =
  'https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQCB/securities.json?iss.meta=off'

// Выбранные эмитенты. Включение в справочник не является оценкой кредитного риска.
export const SAFE_ISSUERS = [
  { pattern: /^сбер/i, code: 'sber', name: 'Сбербанк' },
  { pattern: /^втб/i, code: 'vtb', name: 'ВТБ' },
  { pattern: /^газпром/i, code: 'gazprom', name: 'Газпром' },
  { pattern: /^ржд/i, code: 'rzd', name: 'РЖД' },
  { pattern: /^роснфт|^роснефть/i, code: 'rosneft', name: 'Роснефть' },
  { pattern: /^ростел/i, code: 'rostelecom', name: 'Ростелеком' },
  { pattern: /^дом\.?рф|^дом /i, code: 'domrf', name: 'ДОМ.РФ' },
  { pattern: /^рсхб/i, code: 'rshb', name: 'Россельхозбанк' },
  { pattern: /^фск/i, code: 'fsk', name: 'ФСК ЕЭС' },
  { pattern: /^россети/i, code: 'rosseti', name: 'Россети' },
  { pattern: /^трансн|^трансф/i, code: 'transneft', name: 'Транснефть' },
  { pattern: /^гтлк/i, code: 'gtlk', name: 'ГТЛК' },
  { pattern: /^атомэн/i, code: 'rosatom', name: 'Росатом' },
]

export async function fetchBonds() {
  const [ofzResponse, corpResponse] = await Promise.all([
    fetch(MOEX_OFZ_URL, { signal: AbortSignal.timeout(15000) }),
    fetch(MOEX_CORP_URL, { signal: AbortSignal.timeout(15000) }),
  ])

  if (!ofzResponse.ok) {
    throw new Error(`MOEX API error (OFZ): ${ofzResponse.status}`)
  }
  if (!corpResponse.ok) {
    throw new Error(`MOEX API error (Corp): ${corpResponse.status}`)
  }

  const [ofzData, corpData] = await Promise.all([
    ofzResponse.json(),
    corpResponse.json(),
  ])

  const ofzBonds = parseMoexResponse(ofzData, 'ofz', MOEX_OFZ_URL)
  const corpBonds = parseCorpResponse(corpData, MOEX_CORP_URL)

  return [...ofzBonds, ...corpBonds]
}

export function parseMoexResponse(data, boardType, sourceUrl = MOEX_OFZ_URL) {
  const { securities, marketdata } = data

  const secCols = mapColumns(securities.columns)
  const mdCols = mapColumns(marketdata.columns)

  const marketDataMap = new Map(
    marketdata.data.map((row) => [row[mdCols.SECID], row])
  )
  const yields = yieldRows(data)

  return securities.data
    .filter((row) => isOFZ(row[secCols.SECID], row[secCols.SHORTNAME]))
    .map((row) =>
      createBond(row, secCols, marketDataMap.get(row[secCols.SECID]), mdCols, boardType, null, sourceUrl, yields.get(row[secCols.SECID]))
    )
    .filter((bond) => bond.daysToMaturity > 0)
}

function parseCorpResponse(data, sourceUrl) {
  const { securities, marketdata } = data

  const secCols = mapColumns(securities.columns)
  const mdCols = mapColumns(marketdata.columns)

  const marketDataMap = new Map(
    marketdata.data.map((row) => [row[mdCols.SECID], row])
  )

  const bonds = []
  const yields = yieldRows(data)

  for (const row of securities.data) {
    const shortName = row[secCols.SHORTNAME]
    if (!shortName) continue

    // Проверяем субфедеральные (Москва, МосОбласть)
    const subfedType = getSubfedType(shortName)
    if (subfedType) {
      const bond = createBond(row, secCols, marketDataMap.get(row[secCols.SECID]), mdCols, 'subfed', subfedType, sourceUrl, yields.get(row[secCols.SECID]))
      if (bond.daysToMaturity > 0) bonds.push(bond)
      continue
    }

    // Ограниченный справочник выбранных эмитентов.
    const issuer = getSafeIssuer(shortName)
    if (issuer) {
      const bond = createBond(row, secCols, marketDataMap.get(row[secCols.SECID]), mdCols, 'corp', issuer, sourceUrl, yields.get(row[secCols.SECID]))
      if (bond.daysToMaturity > 0) bonds.push(bond)
    }
  }

  return bonds
}

function isOFZ(secId, shortName) {
  if (!secId?.startsWith('SU')) return false
  return shortName?.includes('ОФЗ') || /^SU2[69]\d{3}/.test(secId)
}

function getSubfedType(shortName) {
  const name = shortName.toLowerCase()
  if (name.includes('мособ') || name.includes('сфо мо')) {
    return { code: 'mo', name: 'МосОбласть' }
  }
  if (name.includes('мгор')) {
    return { code: 'msk', name: 'Москва' }
  }
  return null
}

function getSafeIssuer(shortName) {
  for (const issuer of SAFE_ISSUERS) {
    if (issuer.pattern.test(shortName)) {
      return { code: issuer.code, name: issuer.name }
    }
  }
  return null
}

function mapColumns(columns) {
  return Object.fromEntries(columns.map((col, idx) => [col, idx]))
}

function yieldRows(data) {
  const block = data.marketdata_yields
  if (!block) return new Map()
  return new Map(block.data.map(row => {
    const item = Object.fromEntries(block.columns.map((key, i) => [key, row[i] ?? null]))
    return [item.SECID, item]
  }))
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return null
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null
}

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const currency = value => value === 'SUR' ? 'RUB' : value ?? null

export function createBond(secRow, secCols, mdRow, mdCols, boardType, issuer, sourceUrl, yields = {}) {
  const security = Object.fromEntries(Object.entries(secCols).map(([key, i]) => [key, secRow[i] ?? null]))
  const market = Object.fromEntries(Object.entries(mdCols).map(([key, i]) => [key, mdRow?.[i] ?? null]))
  const maturityDate = validDate(security.MATDATE)
  const daysToMaturity = maturityDate
    ? Math.ceil((maturityDate - new Date()) / 86400000)
    : 0

  const nextCouponDate = validDate(security.NEXTCOUPON)
  const couponKind = /плавающ|ОФЗ-ПК/i.test(`${security.BONDTYPE} ${security.SECNAME}`) ? 'floating'
    : /индексир/i.test(`${security.FACEVALUE_TYPE} ${security.SECNAME}`) || /ОФЗ-ИН/.test(security.SECNAME) ? 'indexed'
    : /фиксирован|известн|ОФЗ-ПД/.test(`${security.BONDTYPE} ${security.SECNAME}`) ? 'known' : 'unknown'
  const candidates = [
    ...(number(yields.EFFECTIVEYIELD) !== null ? [[yields.PRICE, yields.EFFECTIVEYIELD, 'marketdata_yields.PRICE', 'marketdata_yields.EFFECTIVEYIELD']] : []),
    [market.LAST, market.YIELD, 'marketdata.LAST', 'marketdata.YIELD'],
    [market.WAPRICE, market.YIELDATWAPRICE, 'marketdata.WAPRICE', 'marketdata.YIELDATWAPRICE'],
    [security.PREVWAPRICE, security.YIELDATPREVWAPRICE, 'securities.PREVWAPRICE', 'securities.YIELDATPREVWAPRICE'],
    [security.PREVPRICE, null, 'securities.PREVPRICE', null],
  ]
  const selected = candidates.find(([price]) => number(price) !== null && price > 0) || [null, null, null, null]
  const modernYield = selected[3]?.startsWith('marketdata_yields.')
  const yieldDate = modernYield ? validDate(yields.YIELDDATE) : validDate(security.BUYBACKDATE) || validDate(security.OFFERDATE) || maturityDate

  return {
    secId: security.SECID,
    shortName: security.SHORTNAME,
    fullName: security.SECNAME,
    boardType,
    issuer,
    price: number(selected[0]),
    yield: number(selected[1]),
    priceSource: selected[2],
    yieldSource: selected[3],
    legacyYield: number(market.YIELD),
    legacyYieldSource: 'marketdata.YIELD',
    lastTradePrice: number(market.LAST),
    yieldDateType: modernYield ? yields.YIELDDATETYPE ?? null : null,
    yieldDate: yieldDate?.toISOString().slice(0, 10) ?? null,
    yieldKind: couponKind === 'floating' ? 'floating_coupon_estimate' : couponKind === 'indexed' ? 'indexed_nominal' : yieldDate && maturityDate && +yieldDate < +maturityDate ? 'to_offer' : 'to_maturity',
    couponKind,
    couponDetails: security.COUPON_DETAILS,
    couponAmountKnown: number(security.COUPONVALUE) !== null && !(couponKind === 'floating' && security.COUPONVALUE === 0 && security.COUPONPERCENT === null),
    maturityDate,
    daysToMaturity,
    nextCouponDate,
    couponValue: number(security.COUPONVALUE),
    couponPercent: number(security.COUPONPERCENT),
    accruedInt: number(security.ACCRUEDINT),
    couponPeriod: number(security.COUPONPERIOD),
    duration: number(market.DURATION),
    faceValue: number(security.FACEVALUEONSETTLEDATE) ?? number(security.FACEVALUE),
    faceCurrency: currency(security.FACEUNIT),
    settlementCurrency: currency(security.CURRENCYID),
    lotSize: number(security.LOTSIZE),
    settlementDate: security.SETTLEDATE,
    source: { url: sourceUrl, fetchedAt: new Date().toISOString(), marketSystemTimeMoscow: market.SYSTIME, marketUpdateTimeMoscow: market.UPDATETIME, tradeTimeMoscow: market.TIME, yieldSystemTimeMoscow: yields.SYSTIME ?? null, yieldTradeMomentMoscow: yields.TRADEMOMENT ?? null, previousDate: security.PREVDATE },
    raw: { securities: security, marketdata: market, marketdata_yields: yields },
  }
}

export async function fetchPaymentSchedule(ticker) {
  const url = `https://iss.moex.com/iss/securities/${encodeURIComponent(ticker)}/bondization.json?iss.meta=off&limit=unlimited`
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`MOEX: календарь выплат HTTP ${response.status}`)
  const data = await response.json()
  const result = { sourceUrl: url, fetchedAt: new Date().toISOString() }
  for (const block of ['coupons', 'amortizations', 'offers']) {
    if (!Array.isArray(data[block]?.columns) || !Array.isArray(data[block]?.data)) throw new Error(`MOEX: нет блока ${block}`)
    const cursor = data[`${block}.cursor`]
    if (cursor?.data?.length) {
      const index = mapColumns(cursor.columns)
      if (cursor.data[0][index.TOTAL] > data[block].data.length) throw new Error('MOEX вернула неполный календарь выплат')
    }
    result[block] = data[block].data.map(row => Object.fromEntries(data[block].columns.map((column, i) => [column, row[i] ?? null])))
  }
  return result
}
