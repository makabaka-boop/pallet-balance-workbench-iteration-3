import { describe, expect, it } from 'vitest';
import { analyzeStability } from './geometry';
import {
  allItemsExact,
  analyzeRobustEdges,
  centroidAtWeights,
  EXACT_CORNER_LIMIT,
  itemRange,
} from './robust';
import { parseWorkspace } from './parse';
import { resolveForm, workspaceToForm } from './form';
import type { CargoItem, Point, Workspace } from './types';

/* -------------------------------------------------------------------------- */
/* 独立预言机：独立于实现，直接枚举全部 2^n 个端点组合、逐边计算有符号距离。   */
/* 少件货物下这是穷举真值，用来核对 analyzeStability 的鲁棒结论。              */
/* -------------------------------------------------------------------------- */

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

function edgeDistance(poly: Point[], edgeIndex: number, p: Point): number {
  const a = poly[edgeIndex];
  const b = poly[(edgeIndex + 1) % poly.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return ((dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.hypot(dx, dy));
}

/** 全角点枚举预言机：返回每条边的最坏距离与全局最坏组合 */
function oracle(poly: Point[], items: CargoItem[]): {
  perEdge: number[];
  globalWorst: number;
  worstMask: number;
  worstEdge: number;
  cogAt: (mask: number) => Point;
} {
  const ranges = items.map(itemRange);
  const n = items.length;
  const perEdge = new Array<number>(poly.length).fill(Infinity);
  let globalWorst = Infinity;
  let worstMask = 0;
  let worstEdge = 0;

  const cogs = new Map<number, Point>();

  for (let mask = 0; mask < 1 << n; mask++) {
    const w = ranges.map((r, i) => r.min + ((mask >> i) & 1) * (r.max - r.min));
    let sx = 0;
    let sy = 0;
    let sw = 0;
    items.forEach((it, i) => {
      sx += w[i] * it.center.x;
      sy += w[i] * it.center.y;
      sw += w[i];
    });
    const g = { x: sx / sw, y: sy / sw };
    cogs.set(mask, g);
    for (let e = 0; e < poly.length; e++) {
      const d = edgeDistance(poly, e, g);
      if (d < perEdge[e]) perEdge[e] = d;
      if (d < globalWorst) {
        globalWorst = d;
        worstMask = mask;
        worstEdge = e;
      }
    }
  }
  return {
    perEdge,
    globalWorst,
    worstMask,
    worstEdge,
    cogAt: (mask) => cogs.get(mask)!,
  };
}

function rndItems(n: number, seed0: number, opts?: { wide?: boolean }): CargoItem[] {
  let seed = seed0;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return Array.from({ length: n }, (_, i) => {
    const w = 5 + rand() * 95;
    const rel = opts?.wide ? 0.05 + rand() * 0.8 : 0.02 + rand() * 0.4;
    return {
      id: `r${i}`,
      weight: w,
      weightMin: w * (1 - rel),
      weightMax: w * (1 + rel),
      center: { x: 8 + rand() * 84, y: 8 + rand() * 84 },
    };
  });
}

describe('鲁棒分析 vs 全端点组合独立预言机（少件货物，走枚举路径）', () => {
  it('n=1..10 多组随机数据：每边最坏距离与全局最坏均与预言机一致', () => {
    for (let n = 1; n <= 10; n++) {
      for (let t = 0; t < 8; t++) {
        const items = rndItems(n, n * 131 + t * 17 + 7);
        const r = analyzeStability({ polygon: square, items, margin: 0 });
        const o = oracle(square, items);

        expect(r.robust.status).not.toBe('indeterminate');
        expect(r.robust.worstMinDistance).toBeCloseTo(o.globalWorst, 10);
        expect(r.robust.edgeWorst).toBeDefined();
        for (let e = 0; e < square.length; e++) {
          const got = r.robust.edgeWorst!.find((x) => x.index === e)!;
          expect(got.worstDistance).toBeCloseTo(o.perEdge[e], 10);
        }
      }
    }
  });

  it('n ≤ EXACT_CORNER_LIMIT 时 2^n 枚举即证明路径', () => {
    expect(EXACT_CORNER_LIMIT).toBeGreaterThanOrEqual(10);
  });

  it('判定阈值：以预言机最坏距离为界，margin 低于/等于/高于最坏时结论对应 pass/相等-pass/fail', () => {
    const items = rndItems(5, 4242, { wide: true });
    const o = oracle(square, items);

    const below = analyzeStability({ polygon: square, items, margin: o.globalWorst - 1 });
    expect(below.robust.status).toBe('robust-pass');
    expect(below.releasable).toBe(true);

    // 边界相等：未舍入比较，恰在边界上仍算通过（无 epsilon 倾斜）
    const exact = analyzeStability({ polygon: square, items, margin: o.globalWorst });
    expect(exact.robust.status).toBe('robust-pass');

    const above = analyzeStability({ polygon: square, items, margin: o.globalWorst + 1 });
    expect(above.robust.status).toBe('robust-fail');
    expect(above.releasable).toBe(false);
  });

  it('robust-pass 时：每个端点组合、每条边的距离都 ≥ margin（证明完备，非抽样）', () => {
    const items = rndItems(7, 99, { wide: true });
    const o = oracle(square, items);
    const margin = o.globalWorst - 2;
    const r = analyzeStability({ polygon: square, items, margin });
    expect(r.robust.status).toBe('robust-pass');

    const ranges = items.map(itemRange);
    for (let mask = 0; mask < 1 << items.length; mask++) {
      const w = ranges.map((rr, i) => rr.min + ((mask >> i) & 1) * (rr.max - rr.min));
      const { cog } = centroidAtWeights(items, w);
      for (let e = 0; e < square.length; e++) {
        expect(edgeDistance(square, e, cog)).toBeGreaterThanOrEqual(margin - 1e-9);
      }
    }
  });

  it('robust-fail 时：见证重量全部为区间端点，且独立复算与见证重心/首先失守边一致', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 10, weightMax: 10, center: { x: 50, y: 50 } },
      { id: 'B', weight: 10, weightMin: 1, weightMax: 200, center: { x: 98, y: 50 } },
    ];
    const margin = 5;
    const r = analyzeStability({ polygon: square, items, margin });
    // 标称（各 10）稳定：cog=(74,50)，距右边 26
    expect(r.stable).toBe(true);
    expect(r.robust.status).toBe('robust-fail');
    expect(r.releasable).toBe(false);

    const w = r.robust.witness!;
    expect(w).not.toBeNull();
    // 每个见证重量必须落在某个区间端点上
    w.weights.forEach((wi, i) => {
      const rr = itemRange(items[i]);
      expect(wi === rr.min || wi === rr.max).toBe(true);
    });

    // 独立复算
    const recomputed = centroidAtWeights(items, w.weights);
    expect(w.cog.x).toBeCloseTo(recomputed.cog.x, 12);
    expect(w.cog.y).toBeCloseTo(recomputed.cog.y, 12);
    expect(w.minDistance).toBeCloseTo(edgeDistance(square, w.criticalEdge.index, w.cog), 12);
    expect(w.shortfall).toBeCloseTo(margin - w.minDistance, 12);
    // 该边确实是所有边中距离最小者（“首先失守的边” = 边序最小的最坏边）
    const allD = square.map((_, e) => edgeDistance(square, e, w.cog));
    expect(w.criticalEdge.index).toBe(allD.indexOf(Math.min(...allD)));

    // 与预言机最坏组合吻合
    const o = oracle(square, items);
    expect(w.minDistance).toBeCloseTo(o.globalWorst, 12);
    expect(w.criticalEdge.index).toBe(o.worstEdge);
  });

  it('见证组合确实违反 margin，而标称组合满足（图上标称重心与失败见证并存的依据）', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 10, weightMax: 10, center: { x: 30, y: 50 } },
      { id: 'B', weight: 10, weightMin: 2, weightMax: 200, center: { x: 97, y: 50 } },
    ];
    const r = analyzeStability({ polygon: square, items, margin: 8 });
    expect(r.stable).toBe(true);
    expect(r.robust.status).toBe('robust-fail');
    const w = r.robust.witness!;
    expect(w.minDistance).toBeLessThan(8);
    expect(r.minDistance).toBeGreaterThanOrEqual(8);
    // 标称重心与见证重心是两个不同点
    expect(Math.hypot(w.cog.x - r.cog.x, w.cog.y - r.cog.y)).toBeGreaterThan(1);
  });
});

describe('大 n（>12）走 Charnes–Cooper LP，仍与全端点预言机一致', () => {
  it('n=13/16 随机：每边最坏距离一致，无 indeterminate', () => {
    for (const n of [13, 16]) {
      for (let t = 0; t < 4; t++) {
        const items = rndItems(n, n * 977 + t * 31 + 3, { wide: true });
        const r = analyzeStability({ polygon: square, items, margin: 0 });
        const o = oracle(square, items);
        expect(r.robust.status).not.toBe('indeterminate');
        expect(r.robust.worstMinDistance).toBeCloseTo(o.globalWorst, 8);
        for (let e = 0; e < square.length; e++) {
          const got = r.robust.edgeWorst!.find((x) => x.index === e)!;
          expect(got.worstDistance).toBeCloseTo(o.perEdge[e], 8);
        }
      }
    }
  });

  it('n=20：LP 失败见证与预言机一致且可复算', () => {
    // 1 件重锚 + 19 件可变得很重的右置货物
    const items: CargoItem[] = [
      { id: 'anchor', weight: 60, weightMin: 60, weightMax: 60, center: { x: 50, y: 50 } },
      ...Array.from({ length: 19 }, (_, i) => ({
        id: `i${i}`,
        weight: 6,
        weightMin: 1,
        weightMax: 40,
        center: { x: 99, y: 50 },
      })),
    ];
    const r = analyzeStability({ polygon: square, items, margin: 5 });
    // 独立核验：所有小件取上界时的重心（不依赖 LP 输出）
    const upper = [60, ...Array(19).fill(40)];
    const { cog } = centroidAtWeights(items, upper);
    const dRight = edgeDistance(square, 1, cog);
    expect(dRight).toBeLessThan(5);
    expect(r.robust.status).toBe('robust-fail');
    const w = r.robust.witness!;
    expect(w.cog.x).toBeCloseTo(cog.x, 8);
    expect(w.criticalEdge.index).toBe(1);
    // 见证重量可行：逐件位于区间内
    w.weights.forEach((wi, i) => {
      const rr = itemRange(items[i]);
      expect(wi).toBeGreaterThanOrEqual(rr.min - 1e-9);
      expect(wi).toBeLessThanOrEqual(rr.max + 1e-9);
    });
  });

  it('n=200 在时限内完成且结论非 indeterminate', () => {
    const items: CargoItem[] = Array.from({ length: 200 }, (_, i) => ({
      id: `j${i}`,
      weight: 10,
      weightMin: 5,
      weightMax: 15,
      center: { x: 10 + (i % 9) * 10, y: 10 + Math.floor(i / 9) * 10 % 90 },
    }));
    const r = analyzeStability({ polygon: square, items, margin: 3 });
    expect(r.robust.status).toBe('robust-pass');
    expect(r.releasable).toBe(true);
  });
});

describe('边界相等', () => {
  it('单货物重心恰在 margin 线上：鲁棒 pass（未舍入，无 epsilon）', () => {
    const items: CargoItem[] = [{ id: 'a', weight: 1, center: { x: 50, y: 5 } }];
    const r = analyzeStability({ polygon: square, items, margin: 5 });
    expect(r.robust.status).toBe('robust-pass');
    expect(r.robust.worstMinDistance).toBe(5);
    expect(r.releasable).toBe(true);
  });

  it('多货物最坏角点恰落在 margin 线上：鲁棒 pass', () => {
    // A=10@(50,50) 固定；B∈[1,40]@(50,0)。B=40 时 cog y = 500/50 = 10。
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 10, weightMax: 10, center: { x: 50, y: 50 } },
      { id: 'B', weight: 10, weightMin: 1, weightMax: 40, center: { x: 50, y: 0 } },
    ];
    const r = analyzeStability({ polygon: square, items, margin: 10 });
    expect(r.robust.status).toBe('robust-pass');
    expect(r.robust.worstMinDistance).toBeCloseTo(10, 12);
    // 再大一丝即失败
    const r2 = analyzeStability({ polygon: square, items, margin: 10 + 1e-9 });
    expect(r2.robust.status).toBe('robust-fail');
  });
});

describe('无范围 / 旧 JSON 兼容', () => {
  const base = {
    polygon: [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
    margin: 5,
  };

  it('旧 JSON（无 weightMin/weightMax）解析成功且 allExact', () => {
    const r = parseWorkspace({ ...base, items: [{ id: 'a', weight: 12, center: [40, 40] }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(allItemsExact(r.workspace.items)).toBe(true);
      expect(r.workspace.items[0].weightMin).toBeUndefined();
    }
  });

  it('无范围时鲁棒每边最坏距离与标称距离逐项相同，结论与旧口径一致', () => {
    const items: CargoItem[] = [
      { id: 'a', weight: 3, center: { x: 30, y: 20 } },
      { id: 'b', weight: 7, center: { x: 70, y: 80 } },
    ];
    const r = analyzeStability({ polygon: square, items, margin: 5 });
    expect(r.robust.allExact).toBe(true);
    expect(r.robust.worstMinDistance).toBe(r.minDistance);
    for (const e of r.edges) {
      const ew = r.robust.edgeWorst!.find((x) => x.index === e.index)!;
      expect(ew.worstDistance).toBe(e.signedDistance);
    }
    expect(r.robust.status).toBe('robust-pass');
    expect(r.releasable).toBe(r.stable);
  });

  it('无范围但标称 UNSTABLE：鲁棒同样 fail，见证重心即标称重心', () => {
    const items: CargoItem[] = [{ id: 'a', weight: 1, center: { x: 50, y: 2 } }];
    const r = analyzeStability({ polygon: square, items, margin: 5 });
    expect(r.stable).toBe(false);
    expect(r.robust.status).toBe('robust-fail');
    const w = r.robust.witness!;
    expect(w.cog.x).toBe(r.cog.x);
    expect(w.cog.y).toBe(r.cog.y);
    expect(w.criticalEdge.index).toBe(r.criticalEdge.index);
  });

  it('表单无范围编辑回填空白区间字段，往返一致', () => {
    const r = parseWorkspace({ ...base, items: [{ id: 'a', weight: 12, center: [40, 40] }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const form = workspaceToForm(r.workspace);
      expect(form.items[0].weightMin).toBe('');
      expect(form.items[0].weightMax).toBe('');
      const resolved = resolveForm(square, form);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.result.robust.allExact).toBe(true);
    }
  });
});

describe('导入：可选重量区间的严格校验（非法整批拒绝）', () => {
  const base = {
    polygon: [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
    margin: 1,
  };

  it('接受合法双侧区间与合法单侧区间（缺省端沿用标称重量）', () => {
    const r1 = parseWorkspace({
      ...base,
      items: [{ id: 'a', weight: 10, weightMin: 8, weightMax: 12, center: [50, 50] }],
    });
    expect(r1.ok).toBe(true);

    const r2 = parseWorkspace({
      ...base,
      items: [{ id: 'a', weight: 10, weightMin: 8, center: [50, 50] }],
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.workspace.items[0].weightMin).toBe(8);
      expect(r2.workspace.items[0].weightMax).toBe(10);
    }

    const r3 = parseWorkspace({
      ...base,
      items: [{ id: 'a', weight: 10, weightMax: 12, center: [50, 50] }],
    });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.workspace.items[0].weightMin).toBe(10);
  });

  it('拒绝 weightMin > weightMax', () => {
    const r = parseWorkspace({
      ...base,
      items: [{ id: 'a', weight: 10, weightMin: 12, weightMax: 8, center: [50, 50] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/重量区间非法/);
  });

  it('拒绝标称重量落在区间之外', () => {
    const r = parseWorkspace({
      ...base,
      items: [{ id: 'a', weight: 20, weightMin: 8, weightMax: 12, center: [50, 50] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/必须落在登记区间/);
  });

  it('拒绝零、负、非有限的区间端点', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, '9']) {
      const r = parseWorkspace({
        ...base,
        items: [{ id: 'a', weight: 10, weightMin: bad, weightMax: 12, center: [50, 50] }],
      });
      expect(r.ok).toBe(false);
    }
  });

  it('未知字段（含错误拼写的 weight_min）仍然整批拒绝', () => {
    const r = parseWorkspace({
      ...base,
      items: [{ id: 'a', weight: 10, weight_min: 8, center: [50, 50] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/未知字段/);
  });

  it('区间非法与其它错误并存时一次性列出，整批拒绝', () => {
    const r = parseWorkspace({
      polygon: 'bad',
      items: [{ id: 'a', weight: -1, weightMin: 9, weightMax: 8, center: [50, 50] }],
      margin: -2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('行内编辑：非法区间立即撤销当前结论（图文同源、不残留）', () => {
  const polygon = square;
  const start: Workspace = {
    polygon,
    margin: 5,
    items: [
      { id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 40, y: 50 } },
      { id: 'B', weight: 10, weightMin: 8, weightMax: 12, center: { x: 60, y: 50 } },
    ],
  };

  it('合法区间编辑：ok 且 robust 结论随编辑更新', () => {
    const form = workspaceToForm(start);
    // B 标称 10 改到 x=98，上界放宽到 200：标称仍稳但鲁棒失守
    form.items[1].weightMax = '200';
    form.items[1].x = '98';
    const r = resolveForm(polygon, form);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.robust.status).toBe('robust-fail');
      expect(r.result.releasable).toBe(false);
    }
  });

  it('下界＞上界：ok=false，不产出任何结果（结论撤销）', () => {
    const form = workspaceToForm(start);
    form.items[0].weightMin = '50';
    const r = resolveForm(polygon, form);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/重量区间非法/);
  });

  it('区间端点为 0 / 负数 / 乱码：ok=false', () => {
    for (const v of ['0', '-1', 'abc', '']) {
      const form = workspaceToForm(start);
      if (v === '') {
        // 清空下界本身合法（变为单侧）；这里改成清空“重量”才是非法
        form.items[0].weight = '';
      } else {
        form.items[0].weightMin = v;
      }
      const r = resolveForm(polygon, form);
      expect(r.ok).toBe(false);
    }
  });

  it('标称重量被改到区间外：ok=false，修正后同一结果恢复', () => {
    const form = workspaceToForm(start);
    form.items[0].weight = '100';
    expect(resolveForm(polygon, form).ok).toBe(false);
    form.items[0].weight = '10';
    const fixed = resolveForm(polygon, form);
    expect(fixed.ok).toBe(true);
    if (fixed.ok) expect(fixed.result.robust.status).toBe('robust-pass');
  });

  it('撤销状态下没有任何可放行结论：失败时调用方拿不到 StabilityResult', () => {
    const form = workspaceToForm(start);
    form.items[1].weightMax = 'not-a-number';
    const r = resolveForm(polygon, form);
    expect(r.ok).toBe(false);
  });
});

describe('溢出：允许组合合计重量超出 double', () => {
  it('全角点中存在溢出组合：robust-corner-overflow 告警，几何最坏距离照给但不可放行', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 40, y: 50 } },
      { id: 'B', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 60, y: 50 } },
    ];
    const r = analyzeStability({ polygon: square, items, margin: 1 });
    expect(r.totalWeight).toBeNull();
    const codes = r.warnings.map((x) => x.code);
    expect(codes).toContain('total-weight-overflow');
    expect(codes).toContain('robust-corner-overflow');
    expect(r.releasable).toBe(false);
  });

  it('溢出且几何鲁棒失败：见证重量可复算、重心可靠、合计重量显式缺失', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 40, y: 50 } },
      { id: 'B', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 110, y: 50 } },
    ];
    const r = analyzeStability({ polygon: square, items, margin: 1 });
    expect(r.robust.status).toBe('robust-fail');
    const w = r.robust.witness!;
    expect(Number.isFinite(w.cog.x)).toBe(true);
    expect(w.cog.x).toBeCloseTo(110, 8); // A 取下界 1、B 取上界 → 重心≈B
    expect(w.criticalEdge.index).toBe(1);
    expect(w.minDistance).toBeCloseTo(-10, 8);
    // 见证组合本身的合计重量（1+1.7e308 不溢出，可显示）
    expect(w.totalWeight).toBeCloseTo(1.7e308, 6);
    // 独立复算一致
    const rc = centroidAtWeights(items, w.weights);
    expect(rc.cog.x).toBeCloseTo(w.cog.x, 8);
  });

  it('仅部分角点溢出：几何证明仍在归一化重量下完成，但 releasable 恒为 false', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 1, weightMax: 1.7e308, center: { x: 50, y: 50 } },
      { id: 'B', weight: 10, weightMin: 1, weightMax: 1.7e308, center: { x: 50, y: 50 } },
    ];
    const r = analyzeStability({ polygon: square, items, margin: 1 });
    expect(r.warnings.some((x) => x.code === 'robust-corner-overflow')).toBe(true);
    expect(r.releasable).toBe(false);
  });
});

describe('单一结果源：类型/分析层面的图文一致性不变量', () => {
  it('edgeWorst 与最坏边/worstMinDistance/witness 自洽', () => {
    const items = rndItems(6, 7, { wide: true });
    const margin = 20;
    const r = analyzeStability({ polygon: square, items, margin });
    expect(r.robust.edgeWorst).toBeDefined();
    const minW = Math.min(...r.robust.edgeWorst!.map((e) => e.worstDistance));
    expect(minW).toBe(r.robust.worstMinDistance);
    if (r.robust.status === 'robust-fail') {
      const w = r.robust.witness!;
      expect(w.minDistance).toBe(r.robust.worstMinDistance);
      expect(w.criticalEdge.signedDistance).toBe(w.minDistance);
      // SVG/面板消费的边索引在支撑边集合内
      expect(w.criticalEdge.index).toBeGreaterThanOrEqual(0);
      expect(w.criticalEdge.index).toBeLessThan(square.length);
    }
  });

  it('releasable 只可能在 robust-pass、标称稳定、零告警时为 true', () => {
    for (let t = 0; t < 20; t++) {
      const items = rndItems(1 + (t % 8), t * 53 + 11, { wide: true });
      for (const margin of [0, 5, 30, 60]) {
        const r = analyzeStability({ polygon: square, items, margin });
        if (r.releasable) {
          expect(r.stable).toBe(true);
          expect(r.robust.status).toBe('robust-pass');
          expect(r.warnings).toEqual([]);
        }
        if (r.robust.status !== 'robust-pass') expect(r.releasable).toBe(false);
      }
    }
  });

  it('analyzeRobustEdges 直接调用：每条边都给出 proven 结论（少件枚举）', () => {
    const items = rndItems(5, 3, { wide: true });
    const ranges = items.map(itemRange);
    const a = analyzeRobustEdges(square, items, ranges);
    expect(a.edges.length).toBe(4);
    expect(a.edges.every((e) => e.status === 'proven')).toBe(true);
    expect(a.edges.every((e) => e.weights !== null)).toBe(true);
  });
});
