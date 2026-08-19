import fleetMachines from '../data/fleet-machines.json'
import type { KnotAgentHeartbeat } from './knotDispatch'
import { normalizeMachineTarget } from './machineId'

export type FleetCatalogMachine = {
  hostname: string
  aliases: string[]
  kind: 'windows' | 'mac'
  role: 'controller' | 'desktop'
  expectedRepos: Array<{ alias: string; path: string }>
}

export const FLEET_CATALOG: FleetCatalogMachine[] = fleetMachines.machines.map((item) => ({
  hostname: item.hostname,
  aliases: [...item.aliases],
  kind: item.kind as 'windows' | 'mac',
  role: item.role as 'controller' | 'desktop',
  expectedRepos: item.expectedRepos.map((repo) => ({ ...repo })),
}))

export const FLEET_CONTROLLER = fleetMachines.controller

export function catalogHeartbeat(spec: FleetCatalogMachine): KnotAgentHeartbeat {
  return {
    hostname: spec.hostname,
    hostnameNormalized: normalizeMachineTarget(spec.hostname),
    knotFound: false,
    repos: spec.expectedRepos.map((repo) => ({
      alias: repo.alias,
      name: repo.alias,
      path: repo.path,
      source: 'config',
      exists: false,
    })),
    seenAt: 0,
  }
}

export function mergeCatalogAgents(live: KnotAgentHeartbeat[]): KnotAgentHeartbeat[] {
  const map = new Map<string, KnotAgentHeartbeat>()
  for (const spec of FLEET_CATALOG) {
    map.set(normalizeMachineTarget(spec.hostname), catalogHeartbeat(spec))
  }
  for (const agent of live) {
    const key = agent.hostnameNormalized || normalizeMachineTarget(agent.hostname)
    const previous = map.get(key)
    map.set(key, {
      ...previous,
      ...agent,
      repos: (agent.repos && agent.repos.length > 0 ? agent.repos : previous?.repos) || [],
    })
  }
  return [...map.values()]
}

export function findCatalogMachine(raw: string): FleetCatalogMachine | undefined {
  const normalized = normalizeMachineTarget(raw)
  return FLEET_CATALOG.find((item) => {
    if (normalizeMachineTarget(item.hostname) === normalized) return true
    return item.aliases.some((alias) => normalizeMachineTarget(alias) === normalized)
  })
}
