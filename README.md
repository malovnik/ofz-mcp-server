# OFZ MCP Server

MCP (Model Context Protocol) сервер для получения данных об облигациях ОФЗ, субфедеральных и корпоративных с MOEX.

## Инструменты

### get_bonds
Получить список облигаций с фильтрами.

**Параметры:**
- `type` — Тип: `ofz`, `subfed`, `corp` или `all` (по умолчанию `all`)
- `max_months` — Максимальный срок до погашения в месяцах
- `min_yield` — Минимальная доходность в процентах
- `issuer` — Код эмитента (`sber`, `vtb`, `gazprom`, `rzd` и др.)
- `sort_by` — Сортировка: `yield`, `maturity`, `coupon` (по умолчанию `yield`)
- `limit` — Лимит результатов (по умолчанию 20)

### calculate_investment
Рассчитать доход от инвестиции в облигацию.

**Параметры:**
- `ticker` — Тикер облигации (например, `SU26238RMFS4`)
- `amount` — Сумма инвестиции в рублях

### get_issuers
Получить список надёжных эмитентов корпоративных облигаций.

## Эмитенты

| Код | Эмитент | Описание |
|-----|---------|----------|
| `sber` | Сбербанк | Крупнейший банк России |
| `vtb` | ВТБ | Второй госбанк России |
| `gazprom` | Газпром | Крупнейшая газовая компания |
| `rzd` | РЖД | Государственная ж/д монополия |
| `rosneft` | Роснефть | Крупнейшая нефтяная компания |
| `rostelecom` | Ростелеком | Государственный оператор связи |
| `domrf` | ДОМ.РФ | Институт развития жилья |
| `rshb` | Россельхозбанк | Госбанк для АПК |
| `fsk` | ФСК ЕЭС | Магистральные электросети |
| `rosseti` | Россети | Холдинг электросетей |
| `transneft` | Транснефть | Монополия нефтепроводов |
| `gtlk` | ГТЛК | Государственная лизинговая компания |
| `rosatom` | Росатом | Госкорпорация атомной энергетики |

## Локальный запуск

```bash
npm install
npm start
```

Сервер запустится на порту 3001:
- MCP endpoint: `http://localhost:3001/mcp`
- REST API: `http://localhost:3001/api/bonds`
- Health check: `http://localhost:3001/health`

## Рабочий сервер

С29.10.2026 сервер работает на российском Sprintbox рядом с сайтом клуба.
Адрес подключения (Streamable HTTP):

```
https://club.nikexpert.ru/mcp/moex/mcp
```

API-ключи, OAuth и ключ ИИ не нужны. Данные поступают напрямую из MOEX ISS;
модели OpenAI/DeepSeek сервер не вызывает. Прежнее приложение Railway удалено
и возвращает404. Автозапуск, проверки и откат описаны в [deploy/README.md](deploy/README.md).

## Подключение к Claude

В Claude добавьте пользовательский коннектор с URL выше. В Claude Code
можно добавить MCP-сервер в `~/.claude.json`:

```json
{
  "mcpServers": {
    "ofz-bonds": {
      "type": "http",
      "url": "https://club.nikexpert.ru/mcp/moex/mcp"
    }
  }
}
```

Проверка HTTPS и всех трёх инструментов официальным SDK:

```bash
TEST_ENDPOINT=https://club.nikexpert.ru/mcp/moex/mcp npm test
```

## REST API

`GET /api/bonds` — получить облигации в JSON формате.

**Query параметры:**
- `type` — `ofz`, `subfed`, `corp`, `all`
- `max_months` — максимальный срок в месяцах
- `min_yield` — минимальная доходность
- `issuer` — код эмитента
- `sort_by` — `yield`, `maturity`, `coupon`
- `limit` — лимит результатов (по умолчанию 50)

Пример:
```bash
curl "https://club.nikexpert.ru/mcp/moex/api/bonds?type=ofz&limit=5"
```
