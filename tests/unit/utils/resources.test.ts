import { describe, expect, it } from 'vitest';
import { parseCpu, parseGi, summarizeComponents } from '../../../src/utils/resources.js';

describe('parseCpu', () => {
  it.each([
    ['500m', 0.5],
    ['3500m', 3.5],
    ['2', 2],
    ['0.25', 0.25],
    [2, 2],
    ['', 0],
    [undefined, 0],
    [null, 0],
    ['abc', 0],
  ])('%j → %s cores', (input, expected) => {
    expect(parseCpu(input as string | number | undefined | null)).toBe(expected);
  });
});

describe('parseGi', () => {
  it.each([
    ['1Gi', 1],
    ['512Mi', 0.5],
    ['1024Ki', 0.001],
    ['1Ti', 1024],
    ['1G', 0.931],
    ['2147483648', 2],
    ['', 0],
    ['nonsense', 0],
    ['5Zz', 0],
    [undefined, 0],
  ])('%j → %s GiB', (input, expected) => {
    expect(parseGi(input as string | undefined)).toBeCloseTo(expected, 3);
  });
});

describe('summarizeComponents', () => {
  const components = [
    {
      name: 'tools',
      container: { cpuLimit: '2000m', cpuRequest: '500m', memoryLimit: '4Gi', memoryRequest: '1Gi' },
    },
    { name: 'db', container: { cpuLimit: '1', memoryLimit: '512Mi' } },
    { name: 'checode', container: { cpuLimit: '9', memoryLimit: '9Gi' }, volume: { size: '9Gi' } },
    { name: 'venv', volume: { size: '1Gi' } },
    { name: 'home', volume: { size: '2Gi' } },
  ];

  it('sums containers and volumes, excluding the editor component', () => {
    expect(summarizeComponents(components)).toEqual({
      limitcpu: 3,
      requestcpu: 0.5,
      limitmemory: 4.5,
      requestmemory: 1,
      storage: 3,
    });
  });

  it('honours a custom exclusion list', () => {
    expect(summarizeComponents(components, ['checode', 'db']).limitcpu).toBe(2);
  });

  it('returns zeros for nothing', () => {
    expect(summarizeComponents(undefined)).toEqual({
      limitcpu: 0,
      limitmemory: 0,
      requestcpu: 0,
      requestmemory: 0,
      storage: 0,
    });
  });
});
