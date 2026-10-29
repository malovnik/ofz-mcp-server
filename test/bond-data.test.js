import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createBond, parseMoexResponse } from '../src/moexApi.js'
import { publicBond, calculateInvestment, selectBonds } from '../src/bondData.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/moex-ofz-20261029.json', import.meta.url)))
const rawSchedule = JSON.parse(readFileSync(new URL('./fixtures/moex-26238-schedule-20261029.json', import.meta.url)))
const schedule = Object.fromEntries(['coupons', 'amortizations', 'offers'].map(key => [key, rawSchedule[key].data.map(row => Object.fromEntries(rawSchedule[key].columns.map((column, i) => [column, row[i]])))]))
const bonds = parseMoexResponse(fixture, 'ofz')
const fixed = bonds.find(b => b.secId === 'SU26238RMFS4')
const floating = bonds.find(b => b.secId === 'SU29028RMFS6')

function fromRaw(security, market) {
  return createBond(Object.values(security), Object.fromEntries(Object.keys(security).map((key, i) => [key, i])), Object.values(market), Object.fromEntries(Object.keys(market).map((key, i) => [key, i])), 'ofz', null, 'https://iss.moex.com/')
}

test('ОФЗ 29028: современная эффективная доходность отделена от старого YIELD; неизвестный купон не превращается в нулевой', () => {
  const actual = publicBond(floating)
  assert.equal(actual.yield, 16.3044)
  assert.equal(actual.yieldSource, 'marketdata_yields.EFFECTIVEYIELD')
  assert.equal(actual.legacyYield, 16.95)
  assert.equal(actual.price, 93.979)
  assert.equal(actual.yieldKind, 'floating_coupon_estimate')
  assert.equal(actual.rawCouponValue, 0)
  assert.equal(actual.couponPercent, null)
  assert.equal(actual.couponAmountKnown, false)
  assert.equal(actual.couponValue, null)
  assert.equal(actual.couponDetails, 'Срочная ставка RUONIA 3m')
  assert.equal(actual.source.marketSystemTimeMoscow, '2026-10-29 11:06:00')
  const calculation = calculateInvestment(floating, 10000)
  assert.ok(calculation.purchase.quantity > 0)
  assert.equal(calculation.cashflows, null)
  assert.match(calculation.reason, /плавающего купона/)
})

test('ОФЗ 26238: точная пара LAST/YIELD и расчёт по календарю, включая последний купон', () => {
  assert.equal(fixed.price, 52.415)
  assert.equal(fixed.yield, 15.9602)
  assert.equal(fixed.couponValue, 35.4)
  const result = calculateInvestment(fixed, 10000, schedule)
  assert.equal(result.status, 'known_cashflows')
  assert.equal(result.purchase.quantity, 18)
  assert.equal(result.purchase.cost, 9956.34)
  assert.equal(result.cashflows.coupons.length, 30)
  assert.equal(result.cashflows.couponTotal, 19116)
  assert.equal(result.cashflows.principalTotal, 18000)
  assert.equal(result.cashflows.grossProfit, 27159.66)
  assert.equal(result.cashflows.couponNext365Days, 1274.4)
  assert.equal(result.cashflows.coupons.at(-1).date, '2041-05-15')
})

test('При отсутствии последней сделки выбирается согласованная пара цены и доходности предыдущей даты', () => {
  const previous = fromRaw(fixed.raw.securities, { ...fixed.raw.marketdata, LAST: null, WAPRICE: null, YIELD: 99 })
  assert.equal(previous.price, 52.434)
  assert.equal(previous.yield, 15.95)
  assert.equal(previous.yieldSource, 'securities.YIELDATPREVWAPRICE')
  assert.equal(previous.source.previousDate, '2026-10-28')
})

test('Нулевой НКД и отрицательная доходность сохраняются; пропуски не становятся 1000 или нулём', () => {
  const zero = fromRaw({ ...fixed.raw.securities, ACCRUEDINT: 0 }, { ...fixed.raw.marketdata, YIELD: -0.2 })
  assert.equal(publicBond(zero).accruedInt, 0)
  assert.equal(publicBond(zero).yield, -0.2)
  const missing = fromRaw({ ...fixed.raw.securities, FACEVALUE: null, FACEVALUEONSETTLEDATE: null, ACCRUEDINT: null }, fixed.raw.marketdata)
  assert.equal(missing.faceValue, null)
  assert.equal(calculateInvestment(missing, 10000, schedule).purchase, null)
  const unknown = fromRaw({ ...fixed.raw.securities, SECNAME: 'Корпоративный выпуск', BONDTYPE: 'Облигация с фиксированным (неизвестным) купоном', COUPON_DETAILS: 'Фиксированный с неизвестными купонами' }, fixed.raw.marketdata)
  assert.equal(unknown.couponKind, 'unknown')
  assert.equal(calculateInvestment(unknown, 10000, schedule).cashflows, null)
})

test('Валютный выпуск не считается рублёвым; индексация, оферта и неполный календарь не дают вымышленной прибыли', () => {
  const foreign = { ...fixed, faceCurrency: 'CNY' }
  assert.equal(calculateInvestment(foreign, 10000, schedule).purchase, null)
  assert.equal(calculateInvestment({ ...fixed, couponKind: 'indexed' }, 10000, schedule).cashflows, null)
  assert.equal(calculateInvestment(fixed, 10000, { ...schedule, coupons: schedule.coupons.slice(0, -1) }).cashflows, null)
  assert.equal(calculateInvestment(fixed, 10000, { ...schedule, offers: [{ offerdate: '2027-01-01' }] }).cashflows, null)
})

test('Размер лота и дата фиксации учитываются; сортировка не меняет общий кэш', () => {
  const input = [...bonds]
  selectBonds(input, { sort_by: 'yield' })
  assert.deepEqual(input.map(b => b.secId), bonds.map(b => b.secId))
  const lot = calculateInvestment({ ...fixed, lotSize: 10 }, 10000, schedule)
  assert.equal(lot.purchase.quantity, 10)
  assert.ok(lot.purchase.cost <= 10000)
  const afterRecord = calculateInvestment({ ...fixed, settlementDate: '2026-12-02' }, 10000, schedule)
  assert.equal(afterRecord.cashflows.coupons.length, 29)
  const zeroBudget = calculateInvestment(fixed, 1, schedule)
  assert.equal(zeroBudget.purchase.quantity, 0)
  assert.equal(zeroBudget.cashflows.grossProfit, 0)
})
