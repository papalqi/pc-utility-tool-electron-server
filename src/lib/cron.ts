type CronFieldRange = {
  min: number
  max: number
}

export type CronMatchResult =
  | { ok: true; matches: boolean }
  | { ok: false; error: string }

const ranges: Record<'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek', CronFieldRange> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
}

const isWithinRange = (value: number, range: CronFieldRange): boolean =>
  value >= range.min && value <= range.max

const parseInteger = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

const expandRange = (start: number, end: number, step: number, range: CronFieldRange): number[] | null => {
  if (step <= 0) return null
  if (!isWithinRange(start, range) || !isWithinRange(end, range)) return null
  if (start > end) return null

  const values: number[] = []
  for (let i = start; i <= end; i += step) {
    values.push(i)
  }
  return values
}

const expandToken = (token: string, range: CronFieldRange): number[] | null => {
  const trimmed = token.trim()
  if (!trimmed) return null

  if (trimmed.includes('/')) {
    const [basePartRaw, stepRaw] = trimmed.split('/')
    if (basePartRaw === undefined || stepRaw === undefined) return null
    const step = parseInteger(stepRaw)
    if (step === null || step <= 0) return null

    const basePart = basePartRaw.trim()
    if (basePart === '*' || basePart === '') {
      return expandRange(range.min, range.max, step, range)
    }

    if (basePart.includes('-')) {
      const [startRaw, endRaw] = basePart.split('-')
      if (startRaw === undefined || endRaw === undefined) return null
      const start = parseInteger(startRaw)
      const end = parseInteger(endRaw)
      if (start === null || end === null) return null
      return expandRange(start, end, step, range)
    }

    const start = parseInteger(basePart)
    if (start === null) return null
    return expandRange(start, range.max, step, range)
  }

  if (trimmed.includes('-')) {
    const [startRaw, endRaw] = trimmed.split('-')
    if (startRaw === undefined || endRaw === undefined) return null
    const start = parseInteger(startRaw)
    const end = parseInteger(endRaw)
    if (start === null || end === null) return null
    return expandRange(start, end, 1, range)
  }

  if (trimmed === '*') {
    return expandRange(range.min, range.max, 1, range)
  }

  const value = parseInteger(trimmed)
  if (value === null) return null
  if (!isWithinRange(value, range)) return null
  return [value]
}

const parseField = (field: string, range: CronFieldRange): Set<number> | null => {
  const trimmed = field.trim()
  if (!trimmed) return null

  const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null

  const values = new Set<number>()
  for (const part of parts) {
    const expanded = expandToken(part, range)
    if (!expanded) return null
    for (const value of expanded) {
      values.add(value)
    }
  }

  return values
}

const normalizeDayOfWeek = (value: number): number => {
  if (value === 7) return 0
  return value
}

export const validateCronExpression = (expression: string): CronMatchResult => {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { ok: false, error: 'Cron 表达式必须是 5 段（分 时 日 月 周）' }
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  if (!parseField(minute, ranges.minute)) return { ok: false, error: 'Cron 分钟字段无效' }
  if (!parseField(hour, ranges.hour)) return { ok: false, error: 'Cron 小时字段无效' }
  if (!parseField(dayOfMonth, ranges.dayOfMonth)) return { ok: false, error: 'Cron 日期字段无效' }
  if (!parseField(month, ranges.month)) return { ok: false, error: 'Cron 月份字段无效' }
  if (!parseField(dayOfWeek, ranges.dayOfWeek)) return { ok: false, error: 'Cron 星期字段无效' }

  return { ok: true, matches: false }
}

export const isCronMatch = (expression: string, date: Date): CronMatchResult => {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { ok: false, error: 'Cron 表达式必须是 5 段（分 时 日 月 周）' }
  }

  const [minuteField, hourField, domField, monthField, dowField] = parts

  const minuteSet = parseField(minuteField, ranges.minute)
  const hourSet = parseField(hourField, ranges.hour)
  const domSet = parseField(domField, ranges.dayOfMonth)
  const monthSet = parseField(monthField, ranges.month)
  const dowSet = parseField(dowField, ranges.dayOfWeek)

  if (!minuteSet || !hourSet || !domSet || !monthSet || !dowSet) {
    return { ok: false, error: 'Cron 表达式解析失败' }
  }

  const minute = date.getMinutes()
  const hour = date.getHours()
  const dom = date.getDate()
  const month = date.getMonth() + 1
  const dow = normalizeDayOfWeek(date.getDay())

  const minuteOk = minuteSet.has(minute)
  const hourOk = hourSet.has(hour)
  const monthOk = monthSet.has(month)

  const domWildcard = domField.trim() === '*'
  const dowWildcard = dowField.trim() === '*'

  const domOk = domSet.has(dom)
  const dowOk = new Set(Array.from(dowSet).map(normalizeDayOfWeek)).has(dow)

  const dayOk = domWildcard && dowWildcard
    ? true
    : domWildcard
      ? dowOk
      : dowWildcard
        ? domOk
        : domOk || dowOk

  return {
    ok: true,
    matches: minuteOk && hourOk && monthOk && dayOk,
  }
}
