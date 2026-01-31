const MOEX_OFZ_URL =
  'https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQOB/securities.json?iss.meta=off'

const MOEX_CORP_URL =
  'https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQCB/securities.json?iss.meta=off'

// Надёжные эмитенты: госбанки, квазисуверенные компании
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
  { pattern: /^трансн|^трансф|^трансм/i, code: 'transneft', name: 'Транснефть' },
  { pattern: /^гтлк/i, code: 'gtlk', name: 'ГТЛК' },
  { pattern: /^атомэн/i, code: 'rosatom', name: 'Росатом' },
]

export async function fetchBonds() {
  const [ofzResponse, corpResponse] = await Promise.all([
    fetch(MOEX_OFZ_URL),
    fetch(MOEX_CORP_URL),
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

  const ofzBonds = parseMoexResponse(ofzData, 'ofz')
  const corpBonds = parseCorpResponse(corpData)

  return [...ofzBonds, ...corpBonds]
}

function parseMoexResponse(data, boardType) {
  const { securities, marketdata } = data

  const secCols = mapColumns(securities.columns)
  const mdCols = mapColumns(marketdata.columns)

  const marketDataMap = new Map(
    marketdata.data.map((row) => [row[mdCols.SECID], row])
  )

  return securities.data
    .filter((row) => isOFZ(row[secCols.SECID], row[secCols.SHORTNAME]))
    .map((row) =>
      createBond(row, secCols, marketDataMap.get(row[secCols.SECID]), mdCols, boardType, null)
    )
    .filter((bond) => bond.daysToMaturity > 0)
}

function parseCorpResponse(data) {
  const { securities, marketdata } = data

  const secCols = mapColumns(securities.columns)
  const mdCols = mapColumns(marketdata.columns)

  const marketDataMap = new Map(
    marketdata.data.map((row) => [row[mdCols.SECID], row])
  )

  const bonds = []

  for (const row of securities.data) {
    const shortName = row[secCols.SHORTNAME]
    if (!shortName) continue

    // Проверяем субфедеральные (Москва, МосОбласть)
    const subfedType = getSubfedType(shortName)
    if (subfedType) {
      const bond = createBond(row, secCols, marketDataMap.get(row[secCols.SECID]), mdCols, 'subfed', subfedType)
      if (bond.daysToMaturity > 0) bonds.push(bond)
      continue
    }

    // Проверяем надёжные корпоративные
    const issuer = getSafeIssuer(shortName)
    if (issuer) {
      const bond = createBond(row, secCols, marketDataMap.get(row[secCols.SECID]), mdCols, 'corp', issuer)
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

function createBond(secRow, secCols, mdRow, mdCols, boardType, issuer) {
  const maturityDate = secRow[secCols.MATDATE]
    ? new Date(secRow[secCols.MATDATE])
    : null
  const daysToMaturity = maturityDate
    ? Math.ceil((maturityDate - new Date()) / 86400000)
    : 0

  const nextCouponRaw = secRow[secCols.NEXTCOUPON]
  const nextCouponDate = nextCouponRaw ? new Date(nextCouponRaw) : null

  return {
    secId: secRow[secCols.SECID],
    shortName: secRow[secCols.SHORTNAME],
    boardType,
    issuer,
    price: mdRow?.[mdCols.LAST] ?? mdRow?.[mdCols.MARKETPRICE] ?? secRow[secCols.PREVPRICE] ?? null,
    yield: mdRow?.[mdCols.YIELD] ?? secRow[secCols.YIELDATPREVWAPRICE] ?? null,
    maturityDate,
    daysToMaturity,
    nextCouponDate,
    couponValue: secRow[secCols.COUPONVALUE] ?? 0,
    accruedInt: secRow[secCols.ACCRUEDINT] ?? 0,
    couponPeriod: secRow[secCols.COUPONPERIOD] ?? 0,
    duration: mdRow?.[mdCols.DURATION] ?? secRow[secCols.DURATION] ?? null,
    faceValue: secRow[secCols.FACEVALUE] ?? 1000,
  }
}
