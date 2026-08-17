import { normalizeMachineTarget, type KnotAgentHeartbeat } from './knotDispatch'

export type FleetCatalogMachine = {
  hostname: string
  aliases: string[]
  kind: 'windows' | 'mac'
  role: 'controller' | 'desktop'
  expectedRepos: Array<{ alias: string; path: string }>
}

export const FLEET_CATALOG: FleetCatalogMachine[] = [
  {
    hostname: 'PAPEHUANG-PC5',
    aliases: ['PC5'],
    kind: 'windows',
    role: 'controller',
    expectedRepos: [
      { alias: 'utility-tool', path: 'E:\\projects\\utility-tool' },
      { alias: 'control', path: 'E:\\projects\\Control' },
      { alias: 'profile', path: 'D:\\profile' },
      { alias: 'renderdoc', path: 'E:\\projects\\RenderdocAI' },
      { alias: 'mha-main', path: 'D:\\MHAarashiMain' },
      { alias: 'mha-engine', path: 'D:\\EnginePC5' },
      { alias: 'mha-stable', path: 'D:\\MHAStableGPUSceneAB' },
    ],
  },
  {
    hostname: 'PAPEHUANG-PC6',
    aliases: ['PC6'],
    kind: 'windows',
    role: 'desktop',
    expectedRepos: [
      { alias: 'control', path: 'E:\\control' },
      { alias: 'profile', path: 'E:\\profile' },
      { alias: 'mha-main', path: 'E:\\MainMHPC6' },
      { alias: 'mha-engine', path: 'E:\\EngineMHPC6' },
      { alias: 'mha-engine-alt', path: 'E:\\PC6Engine' },
      { alias: 'mha-stable', path: 'E:\\stablepc6' },
    ],
  },
  {
    hostname: 'PAPEHUANG-PC0',
    aliases: ['PC0', 'papehuang-PC0'],
    kind: 'windows',
    role: 'desktop',
    expectedRepos: [
      { alias: 'control', path: 'H:\\project\\control' },
      { alias: 'profile', path: 'G:\\profile' },
      { alias: 'mha-main-withdev', path: 'H:\\MainMH' },
      { alias: 'mha-main', path: 'G:\\MHAC' },
      { alias: 'mha-engine', path: 'G:\\MHAClient_Engine' },
      { alias: 'mha-stable', path: 'H:\\StableMH' },
    ],
  },
  {
    hostname: 'PAPEHUANG-MC2',
    aliases: ['MC2'],
    kind: 'mac',
    role: 'desktop',
    expectedRepos: [
      { alias: 'profile', path: '/Users/papalqi/profile' },
      { alias: 'utility-tool', path: '/Users/papalqi/utility-tool' },
      { alias: 'mha-main', path: '/Volumes/P4Storage/MHAClient_main' },
      { alias: 'mha-engine', path: '/Volumes/P4Storage/MHEngine' },
    ],
  },
  {
    hostname: 'ALLENSHI-PC5',
    aliases: ['ALLENSHI'],
    kind: 'windows',
    role: 'desktop',
    expectedRepos: [
      { alias: 'utility-tool', path: 'F:\\utility-tool' },
      { alias: 'mha-engine', path: 'F:\\MHAClient_engine-ue5' },
      { alias: 'mha-harmonyos', path: 'F:\\MHAClient_HarmonyOS' },
    ],
  },
]

export const FLEET_CONTROLLER = 'PAPEHUANG-PC5'

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