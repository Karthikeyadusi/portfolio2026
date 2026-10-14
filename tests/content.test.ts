import { describe, expect, it } from 'vitest';
import { capabilities, navSections, projects, site } from '../src/data/content';
import { meshForTier } from '../src/scenes/coreRenderer';

describe('content', () => {
  it('ships the three shipped projects, in prominence order', () => {
    expect(projects.map((p) => p.id)).toEqual(['aegislogix', 'attendly', 'gitrunbykaru']);
    expect(projects.map((p) => p.name)).toEqual(['AegisLogix', 'Attendly', 'GitRunByKaru']);
    expect(projects.map((p) => p.index)).toEqual(['01', '02', '03']);
  });

  it('gives every project a distinct visual identity', () => {
    const accents = projects.map((p) => p.accentHex);
    expect(new Set(accents).size).toBe(projects.length);
    expect(new Set(accents)).toEqual(new Set(['#5fe3cf', '#ff8b4c', '#a892ff']));
  });

  it('keeps every project fully written', () => {
    for (const p of projects) {
      expect(p.summary.length).toBeGreaterThan(40);
      expect(p.body.length).toBeGreaterThan(80);
      expect(p.discipline.length).toBeGreaterThan(8);
      expect(p.meta.length).toBeGreaterThanOrEqual(3);
      for (const m of p.meta) {
        expect(m.label.length).toBeGreaterThan(1);
        expect(m.value.length).toBeGreaterThan(1);
      }
    }
  });

  it('quotes the resume metrics exactly, without rounding or inflation', () => {
    const vision = projects[0];
    expect(vision.meta.some((m) => m.value === 'mAP50 0.217 → 0.561')).toBe(true);
    expect(vision.summary).toContain('0.217 to 0.561 mAP50');
    expect(vision.body).toContain('0.83 mAP50');

    const product = projects[1];
    expect(product.meta.some((m) => m.value === '20 students')).toBe(true);
    expect(product.meta.some((m) => m.value === '3 semesters')).toBe(true);

    const tooling = projects[2];
    expect(tooling.meta.some((m) => m.value === '1,500+')).toBe(true);
    expect(tooling.meta.some((m) => m.value === 'MCP')).toBe(true);
  });

  it('covers the four capability areas the resume supports', () => {
    expect(capabilities).toHaveLength(4);
    const joined = capabilities.map((c) => c.title.toLowerCase()).join(' | ');
    expect(joined).toContain('frontend');
    expect(joined).toContain('backend');
    expect(joined).toContain('computer vision');
    expect(joined).toContain('developer tooling');
    for (const c of capabilities) {
      expect(c.tags.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('drops the claims the resume cannot support', () => {
    const text = [
      ...projects.flatMap((p) => [p.summary, p.body, ...p.meta.map((m) => m.value)]),
      ...capabilities.flatMap((c) => [c.title, c.body]),
      site.role ?? '',
    ]
      .join(' ')
      .toLowerCase();
    for (const unsupported of [
      'webgpu',
      'touchdesigner',
      'rust',
      'wgsl',
      'shader',
      'creative coding',
      'interactive graphics',
    ]) {
      expect(text, `must not claim "${unsupported}"`).not.toContain(unsupported);
    }
  });

  it('has one nav entry per section', () => {
    expect(navSections.map((s) => s.id)).toEqual(['intro', 'work', 'about', 'contact']);
    expect(navSections.map((s) => s.index)).toEqual(['01', '02', '03', '04']);
  });

  it('exposes the real professional links', () => {
    expect(site.name).toBe('KARTHIKEYA DUSI');
    expect(site.email).toBe('karthikeyadusi@gmail.com');
    expect(site.location).toBe('Visakhapatnam, India');
    expect(site.links.map((l) => l.label)).toEqual(['GitHub', 'LinkedIn', 'npm']);
    for (const link of site.links) expect(link.href).toMatch(/^https:\/\//);
    expect(site.links[0].href).toBe('https://github.com/Karthikeyadusi');
  });
});

describe('mesh presets', () => {
  it('scales detail down with the quality tier', () => {
    const high = meshForTier('high');
    const low = meshForTier('low');
    expect(high.cols).toBeGreaterThan(low.cols);
    expect(high.satellites).toBeGreaterThan(low.satellites);
  });

  it('drops satellites entirely in ghost mode', () => {
    expect(meshForTier('high', true).satellites).toBe(0);
  });
});
