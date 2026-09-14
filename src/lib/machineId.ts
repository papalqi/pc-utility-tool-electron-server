import fleetMachines from '../data/fleet-machines.json'

type FleetMachineRow = {
  hostname: string
  aliases: string[]
}

const HOST_ALIASES: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const item of fleetMachines.machines as FleetMachineRow[]) {
    map[item.hostname.toUpperCase()] = item.hostname
    for (const alias of item.aliases) {
      map[alias.toUpperCase()] = item.hostname
    }
  }
  return map
})()

export function normalizeMachineTarget(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return ''
  const noDomain = trimmed.split('.')[0] || trimmed
  const upper = noDomain.toUpperCase()
  return HOST_ALIASES[upper] || upper
}

export function targetsMatch(jobTarget: string, hostname: string): boolean {
  const left = normalizeMachineTarget(jobTarget)
  const right = normalizeMachineTarget(hostname)
  return Boolean(left && right && left === right)
}
