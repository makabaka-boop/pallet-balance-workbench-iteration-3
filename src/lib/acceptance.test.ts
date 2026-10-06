import { describe, expect, it } from 'vitest';
import {
  analyzeStability,
  insetPolygon,
  isMarginResolvable,
  weightedCentroid,
} from './geometry';
import { fmt, fmtPair, resolveForm } from './form';
import type { CargoItem, Point, Workspace } from './types';

/** 边长 100 的正方形支承（逆时针） */
const square100: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

function items(...spec: Array<[string, number, number, number]>): CargoItem[] {
  return spec.map(([id, weight, x, y]) => ({ id, weight, center: { x, y } }));
}

function ws(polygon: Point[], list: CargoItem[], margin = 0): Workspace {
  return { polygon, items: list, margin };
}

describe('验收 1：极小正余量（1e-12）下几何区域必须真正内缩', () => {
  const margin = 1e-12;

  it('安全区不再贴在原支承边上（原边顶点不被保留）', () => {
    const region = insetPolygon(square100, margin);
    expect(region.length).toBe(4);
    // 底边 (0,0)→(100,0) 必须向内（+y）平移 1e-12
    const minY = Math.min(...region.map((p) => p.y));
    const maxY = Math.max(...region.map((p) => p.y));
    const minX = Math.min(...region.map((p) => p.x));
    const maxX = Math.max(...region.map((p) => p.x));
    expect(minY).toBeGreaterThan(0);
    expect(minY).toBeCloseTo(margin, 13);
    expect(maxY).toBeCloseTo(100 - margin, 13);
    expect(minX).toBeCloseTo(margin, 13);
    expect(maxX).toBeCloseTo(100 - margin, 13);
    // 关键：任何一个内缩顶点都不得与原支承顶点重合
    for (const v of square100) {
      expect(region.some((p) => p.x === v.x && p.y === v.y)).toBe(false);
    }
  });

  it('该余量在坐标尺度 100 下可分辨', () => {
    expect(isMarginResolvable(square100, margin)).toBe(true);
  });

  it('重心恰在原边上（距离 0）：数值判 UNSTABLE，图形不含该边', () => {
    const r = analyzeStability(ws(square100, items(['a', 1, 50, 0]), margin));
    // 原始数值判定
    expect(r.stable).toBe(false);
    expect(r.releasable).toBe(false);
    expect(r.minDistance).toBe(0);
    expect(r.shortfall).toBeCloseTo(margin, 13);
    // 图形：最危险边就是底边，内缩安全区严格位于边内侧，原边不被当成安全区
    expect(r.criticalEdge.index).toBe(0);
    expect(r.safeRegion.length).toBe(4);
    for (const p of r.safeRegion) {
      expect(p.y).toBeGreaterThan(0);
    }
  });

  it('重心在安全区内侧 2e-12 时 STABLE 且安全区包含重心方向', () => {
    const r = analyzeStability(ws(square100, items(['a', 1, 50, 2e-12]), margin));
    expect(r.stable).toBe(true);
    expect(r.releasable).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('margin=0 兼容：重心恰在边上仍 STABLE，安全区即原多边形', () => {
    const r = analyzeStability(ws(square100, items(['a', 1, 50, 0]), 0));
    expect(r.stable).toBe(true);
    expect(r.releasable).toBe(true);
    expect(r.safeRegion).toBe(square100);
  });
});

describe('验收 2：边界重心的状态、最危险边与图形一致', () => {
  it('零余量边界：边 #0 为最危险边、距离 0、STABLE', () => {
    const r = analyzeStability(ws(square100, items(['a', 1, 37, 0]), 0));
    expect(r.stable).toBe(true);
    expect(r.minDistance).toBe(0);
    expect(r.criticalEdge.index).toBe(0);
    expect(r.shortfall).toBe(0);
  });

  it('正余量边界：重心恰在 margin 线上（未舍入比较）STABLE，无 epsilon 倾斜', () => {
    const r = analyzeStability(ws(square100, items(['a', 1, 50, 5]), 5));
    expect(r.stable).toBe(true);
    expect(r.releasable).toBe(true);
    expect(r.minDistance).toBeCloseTo(5, 12);
  });

  it('重心在右边外：最危险边为右边、距离为负、UNSTABLE', () => {
    const r = analyzeStability(ws(square100, items(['a', 1, 100.25, 50]), 1));
    expect(r.stable).toBe(false);
    expect(r.criticalEdge.index).toBe(1); // (100,0)→(100,100)
    expect(r.minDistance).toBeCloseTo(-0.25, 12);
    expect(r.shortfall).toBeCloseTo(1.25, 12);
  });
});

describe('验收 3：微小短缺/余量在可读指标上不得显示为零', () => {
  it('1e-12 的正余量显示为非零科学计数法', () => {
    expect(fmt(1e-12)).not.toBe('0');
    expect(fmt(1e-12)).toMatch(/e[+-]?\d+/i);
    expect(fmt(-1e-12)).not.toBe('0');
    expect(fmt(0)).toBe('0');
  });

  it('成对比较：实际余量 0 与要求 1e-12 不会显示成“0 ＜ 0”', () => {
    const [actual, required] = fmtPair(0, 1e-12);
    expect(actual).toBe('0');
    expect(required).not.toBe('0');
    // 短缺量 1e-12 与 0 成对时同样可区分
    const [short] = fmtPair(1e-12, 0);
    expect(short).not.toBe('0');
  });

  it('两个不同的微小量（短缺 5e-10 vs 余量 1e-9）显示也可区分', () => {
    const [a, b] = fmtPair(5e-10, 1e-9);
    expect(a).not.toBe(b);
  });

  it('UNSTABLE 结果的短缺量可经面板格式读到非零值', () => {
    const r = analyzeStability(ws(square100, items(['a', 1, 50, 0]), 1e-12));
    expect(r.stable).toBe(false);
    const [short] = fmtPair(r.shortfall, 0);
    expect(short).not.toBe('0');
  });

  it('常规量级仍按 6 位小数显示（兼容）', () => {
    expect(fmt(150)).toBe('150');
    expect(fmt(0.123456789)).toBe('0.123457');
    expect(fmt(0)).toBe('0');
  });
});

describe('验收 4：两件有限合法大重量相加溢出', () => {
  it('直接求和溢出 Infinity 时，合计重量为 null（缺失值）而非伪装成数', () => {
    const { cog, totalWeight, totalWeightOverflowed } = weightedCentroid(
      items(['a', 1.7e308, 0, 0], ['b', 1.7e308, 100, 0]),
    );
    expect(Number.isFinite(1.7e308 + 1.7e308)).toBe(false); // 前提：确实溢出
    expect(totalWeightOverflowed).toBe(true);
    expect(totalWeight).toBeNull();
    // 重心几何仍然可靠（缩放计算）
    expect(Number.isFinite(cog.x)).toBe(true);
    expect(cog.x).toBeCloseTo(50, 8);
  });

  it('分析结果：几何结论照给，但 releasable=false 且有显式告警', () => {
    const r = analyzeStability(
      ws(square100, items(['a', 1.7e308, 40, 50], ['b', 1.7e308, 60, 50]), 1),
    );
    // 重心在中心，按数值是稳定的
    expect(r.stable).toBe(true);
    expect(r.cog.x).toBeCloseTo(50, 8);
    // 但合计重量缺失 → 不可放行
    expect(r.totalWeight).toBeNull();
    expect(r.releasable).toBe(false);
    expect(r.warnings.some((w) => w.code === 'total-weight-overflow')).toBe(true);
  });

  it('重心越界且合重量溢出时仍为 UNSTABLE，告警同样存在', () => {
    const r = analyzeStability(
      ws(square100, items(['a', 1.7e308, -10, 50], ['b', 1.7e308, 0, 50]), 1),
    );
    expect(r.stable).toBe(false);
    expect(r.releasable).toBe(false);
    expect(r.totalWeight).toBeNull();
    // 重心 (-5,50) 已越出左边（边 #3：(0,100)→(0,0)）
    expect(r.criticalEdge.index).toBe(3);
    expect(r.minDistance).toBeCloseTo(-5, 8);
  });

  it('普通大重量（不溢出）正常给出合计重量，可放行', () => {
    const r = analyzeStability(
      ws(square100, items(['a', 1e200, 40, 50], ['b', 1e200, 60, 50]), 1),
    );
    expect(r.totalWeight).toBe(2e200);
    expect(r.warnings).toEqual([]);
    expect(r.releasable).toBe(true);
  });
});

describe('验收 5：低于图形分辨极限的余量必须显式反馈而非贴边', () => {
  it('1e6 坐标尺度下 1e-12 余量不可分辨：安全区为空且告警、暂缓放行', () => {
    const big: Point[] = [
      { x: 0, y: 0 },
      { x: 1e6, y: 0 },
      { x: 1e6, y: 1e6 },
      { x: 0, y: 1e6 },
    ];
    expect(isMarginResolvable(big, 1e-12)).toBe(false);
    expect(insetPolygon(big, 1e-12)).toEqual([]);
    const r = analyzeStability(ws(big, items(['a', 1, 5e5, 5e5]), 1e-12));
    expect(r.safeRegion).toEqual([]);
    expect(r.releasable).toBe(false);
    expect(r.warnings.some((w) => w.code === 'margin-below-resolution')).toBe(true);
    // 数值判定本身不受影响：重心远离边界，仍为稳定
    expect(r.stable).toBe(true);
  });
});

describe('验收 6：导入/编辑解析对同一输入与几何/指标结论一致', () => {
  it('resolveForm：极小正余量 + 边界重心 → UNSTABLE，短缺非零', () => {
    const form = {
      margin: '1e-12',
      items: [{ id: 'a', weight: '1', weightMin: '', weightMax: '', x: '50', y: '0' }],
    };
    const r = resolveForm(square100, form);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.stable).toBe(false);
      expect(r.result.criticalEdge.index).toBe(0);
      expect(r.result.safeRegion.length).toBe(4);
      expect(fmtPair(r.result.shortfall, 0)[0]).not.toBe('0');
    }
  });

  it('resolveForm：溢出重量组合 → ok 但带 overflow 告警、不可放行、合重量缺失', () => {
    const form = {
      margin: '1',
      items: [
        { id: 'a', weight: '1.7e308', weightMin: '', weightMax: '', x: '40', y: '50' },
        { id: 'b', weight: '1.7e308', weightMin: '', weightMax: '', x: '60', y: '50' },
      ],
    };
    const r = resolveForm(square100, form);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.totalWeight).toBeNull();
      expect(r.result.releasable).toBe(false);
      expect(r.result.stable).toBe(true);
    }
  });

  it('resolveForm：常规重量与零余量边界保持兼容', () => {
    const r = resolveForm(square100, {
      margin: '0',
      items: [{ id: 'a', weight: '120', weightMin: '', weightMax: '', x: '50', y: '0' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.stable).toBe(true);
      expect(r.result.totalWeight).toBe(120);
      expect(r.result.safeRegion).toBe(square100);
    }
  });
});
