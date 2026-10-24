export interface ResourceSummary {
  limitcpu: number;
  limitmemory: number;
  requestcpu: number;
  requestmemory: number;
  storage: number;
}

export const EMPTY_RESOURCES: ResourceSummary = {
  limitcpu: 0,
  limitmemory: 0,
  requestcpu: 0,
  requestmemory: 0,
  storage: 0,
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** CPU quantity to cores: `500m` → 0.5, `2` → 2. Unknown or empty → 0. */
export function parseCpu(quantity: string | number | undefined | null): number {
  if (quantity === undefined || quantity === null || quantity === '') return 0;
  if (typeof quantity === 'number') return Number.isFinite(quantity) ? round3(quantity) : 0;
  const q = quantity.trim();
  const value = parseFloat(q);
  if (Number.isNaN(value)) return 0;
  return round3(q.endsWith('m') ? value / 1000 : value);
}

const BYTES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

/** Memory/storage quantity to GiB: `512Mi` → 0.5, `2Gi` → 2, plain numbers are bytes. */
export function parseGi(quantity: string | number | undefined | null): number {
  if (quantity === undefined || quantity === null || quantity === '') return 0;
  const q = String(quantity).trim();
  const match = /^([0-9]*\.?[0-9]+)\s*([A-Za-z]*)$/.exec(q);
  if (!match) return 0;
  const value = parseFloat(match[1] ?? '0');
  const unit = match[2] ?? '';
  if (unit === '') return round3(value / 1024 ** 3);
  const factor = BYTES[unit];
  return factor === undefined ? 0 : round3((value * factor) / 1024 ** 3);
}

interface ContainerLike {
  name?: string;
  container?: {
    cpuLimit?: string;
    cpuRequest?: string;
    memoryLimit?: string;
    memoryRequest?: string;
  };
  volume?: { size?: string };
}

/**
 * Total resources a workspace asks for. The editor component (`checode`) is excluded because it is
 * injected by Dev Spaces and not chosen by the user's stack.
 */
export function summarizeComponents(
  components: readonly ContainerLike[] | undefined,
  excludedNames: readonly string[] = ['checode'],
): ResourceSummary {
  const total = { ...EMPTY_RESOURCES };
  for (const component of components ?? []) {
    if (component.name && excludedNames.includes(component.name)) continue;
    if (component.container) {
      total.limitcpu += parseCpu(component.container.cpuLimit);
      total.requestcpu += parseCpu(component.container.cpuRequest);
      total.limitmemory += parseGi(component.container.memoryLimit);
      total.requestmemory += parseGi(component.container.memoryRequest);
    }
    if (component.volume) total.storage += parseGi(component.volume.size);
  }
  return {
    limitcpu: round3(total.limitcpu),
    limitmemory: round3(total.limitmemory),
    requestcpu: round3(total.requestcpu),
    requestmemory: round3(total.requestmemory),
    storage: round3(total.storage),
  };
}
