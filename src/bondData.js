import { validDate } from './moexApi.js'

export const coverage = 'ОФЗ на TQOB; выпуски Москвы и Мособласти и выбранные корпоративные эмитенты на TQCB. Это ограниченная выборка, не весь рынок облигаций. Акций, фьючерсов и индексов нет.'
export const timing = 'MOEX ISS может отдавать котировки с задержкой. fetchedAt — время получения ответа, а не время сделки. Время биржи и сделки передаётся отдельно по Москве.'

export function selectBonds(bonds, { type = 'all', max_months, min_yield, issuer, sort_by = 'yield', limit = 20, coupon_type = 'all', currency = 'RUB', ticker }) {
  let selected = bonds.filter(b => (type === 'all' || b.boardType === type)
    && (currency === 'all' || b.faceCurrency === currency)
    && (!ticker || b.secId === ticker)
    && (coupon_type === 'all' || b.couponKind === coupon_type)
    && (max_months === undefined || b.daysToMaturity <= max_months * 365.25 / 12)
    && (min_yield === undefined || b.yield !== null && b.yield >= min_yield)
    && (!issuer || b.issuer?.code === issuer))
  const descending = (a, b) => a === null ? b === null ? 0 : 1 : b === null ? -1 : b - a
  selected.sort((a, b) => sort_by === 'maturity' ? a.daysToMaturity - b.daysToMaturity
    : sort_by === 'coupon' ? descending(a.couponAmountKnown ? a.couponValue : null, b.couponAmountKnown ? b.couponValue : null)
      : descending(a.yield, b.yield))
  return { total: selected.length, bonds: selected.slice(0, limit) }
}

export function publicBond(b) {
  const notes = []
  if (b.couponKind === 'floating') notes.push('Плавающий купон: доходность MOEX является расчётным показателем с предположениями о будущих ставках; фиксированного дохода до погашения нет.')
  if (b.indexedNominal || b.couponKind === 'indexed') notes.push('Индексируемый номинал: показатель доходности нельзя смешивать с номинальной доходностью обычных облигаций.')
  if (!b.couponAmountKnown) notes.push('Сумма ближайшего купона в ISS не определена; rawCouponValue сохраняет исходное значение, включая ноль.')
  if (b.priceSource?.startsWith('securities.')) notes.push('Цена и доходность взяты за предыдущую торговую дату, указанную в source.previousDate.')
  return {
    ticker: b.secId, name: b.shortName, fullName: b.fullName, type: b.boardType,
    issuer: b.issuer?.name ?? (b.boardType === 'ofz' ? 'Минфин РФ' : null),
    price: b.price, priceUnit: '% номинала', priceSource: b.priceSource,
    yield: b.yield, yieldUnit: '% годовых', yieldSource: b.yieldSource, yieldKind: b.yieldKind, yieldDate: b.yieldDate, yieldDateType: b.yieldDateType,
    legacyYield: b.legacyYield, legacyYieldSource: b.legacyYieldSource, lastTradePrice: b.lastTradePrice,
    yieldMethodology: 'https://www.moex.com/n95432',
    maturityDate: b.maturityDate?.toISOString().slice(0, 10) ?? null, daysToMaturity: b.daysToMaturity,
    couponKind: b.couponKind, couponDetails: b.couponDetails, bondType: b.bondType, faceValueType: b.faceValueType, indexedNominal: b.indexedNominal,
    couponValue: b.couponAmountKnown ? b.couponValue : null, rawCouponValue: b.couponValue, couponPercent: b.couponPercent,
    couponAmountKnown: b.couponAmountKnown, nextCouponDate: b.nextCouponDate?.toISOString().slice(0, 10) ?? null,
    accruedInt: b.accruedInt, faceValue: b.faceValue, faceCurrency: b.faceCurrency,
    settlementCurrency: b.settlementCurrency, lotSize: b.lotSize, settlementDate: b.settlementDate,
    source: b.source, notes,
  }
}

export function bondsText(bonds) {
  const fmt = value => value === null ? 'нет данных' : value.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
  return bonds.map((b, i) => `${i + 1}. ${b.name} (${b.ticker})\n`
    + `Цена: ${fmt(b.price)}% [${b.priceSource}]; доходность MOEX: ${fmt(b.yield)}% [${b.yieldSource}; ${b.yieldKind}; дата ${b.yieldDate}].\n`
    + `Купон: ${b.couponAmountKnown ? `${fmt(b.couponValue)} ${b.faceCurrency}` : `размер не определён (ISS COUPONVALUE=${b.rawCouponValue}, COUPONPERCENT=${b.couponPercent})`}; ${b.couponDetails ?? 'тип не указан'}; ближайшая выплата ${b.nextCouponDate}.\n`
    + `НКД: ${fmt(b.accruedInt)} ${b.settlementCurrency}; номинал: ${fmt(b.faceValue)} ${b.faceCurrency}; лот: ${b.lotSize}; погашение: ${b.maturityDate}.\n`
    + `Источник: ${b.source.url}; получено ${b.source.fetchedAt}; биржа ${b.source.marketSystemTimeMoscow}; сделка расчёта доходности ${b.source.yieldTradeMomentMoscow ?? b.source.tradeTimeMoscow} (Москва).\n`
    + b.notes.join(' ')).join('\n\n')
}

const round = n => Math.round((n + Number.EPSILON) * 100) / 100
const sum = rows => rows.reduce((total, row) => total + row.value, 0)
const isMoney = n => typeof n === 'number' && Number.isFinite(n) && n >= 0

// Используем календарь MOEX, не размножаем ближайший купон на все годы.
export function calculateInvestment(bond, amount, schedule) {
  const result = { ticker: bond.secId, budget: amount, currency: 'RUB', quote: publicBond(bond), status: 'partial', purchase: null, cashflows: null, reason: null,
    assumptions: ['Оценка по указанной биржевой цене, а не исполненная сделка.', 'Комиссии, налоги, реинвестирование и риск неисполнения обязательств в суммы не включены.'] }
  if (bond.faceCurrency !== 'RUB' || bond.settlementCurrency !== 'RUB') {
    result.reason = 'Выпуск номинирован или рассчитывается в другой валюте. Конвертацию в рубли без курса и условий расчёта не выполняем.'
    return result
  }
  if (!(bond.price > 0) || !(bond.faceValue > 0) || !isMoney(bond.accruedInt) || !(Number.isInteger(bond.lotSize) && bond.lotSize > 0)) {
    result.reason = 'Для покупки не хватает цены, номинала, НКД или размера лота. Пропуски не заменяются вымышленными значениями.'
    return result
  }
  const unitCost = bond.price / 100 * bond.faceValue + bond.accruedInt
  let lots = Math.floor(amount / (unitCost * bond.lotSize))
  while (lots > 0 && round(lots * bond.lotSize * unitCost) > amount) lots--
  const quantity = lots * bond.lotSize
  const cost = round(quantity * unitCost)
  result.purchase = { lots, quantity, pricePerBondWithAccrued: unitCost, cost, unspent: round(amount - cost), settlementDate: bond.settlementDate }
  if (bond.couponKind !== 'known') {
    result.reason = 'Будущие выплаты зависят от плавающего купона, индексации или неописанных условий. Фиксированную прибыль до погашения не рассчитываем.'
    return result
  }
  if (!schedule) { result.reason = 'Нет полного календаря выплат MOEX.'; return result }
  result.scheduleSource = { url: schedule.sourceUrl, fetchedAt: schedule.fetchedAt }
  const settlement = validDate(bond.settlementDate)
  const maturity = bond.maturityDate
  if (!settlement || !maturity || +settlement >= +maturity) { result.reason = 'Нет корректных дат расчётов и погашения.'; return result }
  const optionalDates = [bond.raw.securities.OFFERDATE, bond.raw.securities.CALLOPTIONDATE, bond.raw.securities.PUTOPTIONDATE, ...schedule.offers.map(r => r.offerdate)].map(validDate).filter(Boolean)
  if (optionalDates.some(date => +date >= +settlement && +date < +maturity)) { result.reason = 'До погашения предусмотрена оферта или опцион. Общую прибыль без выбора сценария не рассчитываем.'; return result }
  const futureCoupons = schedule.coupons.filter(row => validDate(row.coupondate) && +validDate(row.coupondate) > +settlement)
  if (!futureCoupons.length || futureCoupons.some(r => !isMoney(r.value) || !validDate(r.recorddate) || r.faceunit !== 'RUB' && r.faceunit !== 'SUR')) { result.reason = 'В календаре нет полного набора известных купонов в рублях и дат фиксации.'; return result }
  const entitledCoupons = futureCoupons.filter(r => +validDate(r.recorddate) >= +settlement)
  const principal = schedule.amortizations.filter(r => validDate(r.amortdate) && +validDate(r.amortdate) > +settlement)
  if (!principal.length || principal.some(r => !isMoney(r.value) || !['RUB', 'SUR'].includes(r.faceunit)) || Math.abs(sum(principal) - bond.faceValue) > 0.01
      || Math.max(...principal.map(r => +validDate(r.amortdate))) !== +maturity
      || Math.max(...futureCoupons.map(r => +validDate(r.coupondate))) !== +maturity) {
    result.reason = 'Календарь не подтверждает все выплаты номинала и купонов до погашения.'
    return result
  }
  const coupons = entitledCoupons.map(r => ({ date: r.coupondate, recordDate: r.recorddate, perBond: r.value, amount: round(quantity * r.value) }))
  const repayments = principal.map(r => ({ date: r.amortdate, perBond: r.value, amount: round(quantity * r.value) }))
  const couponTotal = round(coupons.reduce((n, r) => n + r.amount, 0))
  const principalTotal = round(repayments.reduce((n, r) => n + r.amount, 0))
  result.status = 'known_cashflows'
  result.cashflows = { coupons, repayments, couponTotal, principalTotal, totalReceipts: round(couponTotal + principalTotal), grossProfit: round(couponTotal + principalTotal - cost),
    couponNext365Days: round(coupons.filter(r => +validDate(r.date) <= +settlement + 365 * 86400000).reduce((n, r) => n + r.amount, 0)) }
  return result
}
