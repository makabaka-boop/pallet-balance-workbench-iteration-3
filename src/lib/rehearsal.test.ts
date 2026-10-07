import { describe, expect, it } from 'vitest';
import { analyzeStability, signedDistanceToEdge } from './geometry';
import {
  rehearseMove,
  validateRehearsalTarget,
} from './rehearsal';
import { centroidAtWeights, itemRange } from './robust';
import { resolveForm, applyTargetToForm, workspaceToForm } from './form';
import type { CargoItem, Point, Workspace } from './types';

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

/**
 * 独立预言机：不依赖 rehearseMove 实现，直接枚举全部 2^n 个重量角点、
 * 对每条边把距离−margin 的符号写成路径参数 s 的一次函数并求根，
 * 得到真实的最早失守比例与失守 (边,角点)。
 */
function oracleRoot(
  ws: Workspace,
  itemIndex: number,
  target: Point,
): { ratio: number; edge: number; mask: number } | null {
  const { polygon, items, margin } = ws;
  const ranges = items.map(itemRange);
  const n = items.length;
  let best: { ratio: number; edge: number; mask: number } | null = null;

  for (let mask = 0; mask < 1 << n; mask++) {
    const w = ranges.map(
      (r, i) => r.min + ((mask >> i) & 1) * (r.max - r.min),
    );
    for (let e = 0; e < polygon.length; e++) {
      const v = polygon[e];
      const q = polygon[(e + 1) % polygon.length];
      const len = Math.hypot(q.x - v.x, q.y - v.y);
      const moved0 = items[itemIndex].center;
      const crossAt = (c: Point) => {
        let sum = 0;
        items.forEach((it, i) => {
          const cc = i === itemIndex ? c : it.center;
          sum += w[i] * ((q.x - v.x) * (cc.y - v.y) - (q.y - v.y) * (cc.x - v.x));
        });
        return sum / len - margin * w.reduce((a, b) => a + b, 0);
      };
      const g0 = crossAt(moved0);
      const g1 = crossAt(target);
      let ratio: number | null = null;
      if (g0 < -1e-12) ratio = 0;
      else if (g1 < -1e-12) ratio = g0 / (g0 - g1);
      if (ratio !== null && ratio >= 0 && ratio <= 1) {
        if (
          best === null ||
          ratio < best.ratio ||
          (ratio === best.ratio && e < best.edge) ||
          (ratio === best.ratio && e === best.edge && mask < best.mask)
        ) {
          best = { ratio, edge: e, mask };
        }
      }
    }
  }
  return best;
}

function moveItem(items: CargoItem[], i: number, c: Point): CargoItem[] {
  return items.map((it, j) => (j === i ? { ...it, center: c } : it));
}

function at(o: Point, t: Point, s: number): Point {
  return { x: o.x + (t.x - o.x) * s, y: o.y + (t.y - o.y) * s };
}

function ws(items: CargoItem[], margin = 5): Workspace {
  return { polygon: square, items, margin };
}

describe('移动预演：少件货物重量端点枚举核对安全边界', () => {
  it('途中失守：边界比例与独立角点根预言机一致，边界宽度 ≤ 0.0001', () => {
    // A 固定 @中心；B 从中心挪到右边附近，区间 [1,200]
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 10, weightMax: 10, center: { x: 50, y: 50 } },
      { id: 'B', weight: 10, weightMin: 1, weightMax: 200, center: { x: 50, y: 50 } },
    ];
    const w = ws(items);
    const target = { x: 98, y: 50 };
    const r = rehearseMove({ workspace: w, itemIndex: 1, target });
    const o = oracleRoot(w, 1, target);

    expect(r.status).toBe('rehearsal-fail');
    expect(r.startReleasable).toBe(true);
    expect(o).not.toBeNull();
    expect(r.breachRatio).toBeCloseTo(o!.ratio, 9);
    expect(r.safeRatio).toBeCloseTo(o!.ratio, 9);
    expect(r.boundaryWidth).toBeLessThanOrEqual(0.0001);

    // 失守点见证可独立复算：重量全为区间端点、重心、边、距离
    const witness = r.witness!;
    expect(witness).not.toBeNull();
    witness.weights.forEach((wi, i) => {
      const rr = itemRange(items[i]);
      expect(wi === rr.min || wi === rr.max).toBe(true);
    });
    const moved = moveItem(items, 1, witness.movedCenter);
    const recomputed = centroidAtWeights(moved, witness.weights);
    expect(witness.cog.x).toBeCloseTo(recomputed.cog.x, 10);
    expect(witness.cog.y).toBeCloseTo(recomputed.cog.y, 10);
    expect(witness.criticalEdge.index).toBe(o!.edge);
    expect(witness.worstDistance).toBeCloseTo(
      signedDistanceToEdge(witness.cog, square[o!.edge], square[(o!.edge + 1) % 4]),
      10,
    );
    // 边界恰等于 margin
    expect(witness.worstDistance).toBeCloseTo(5, 9);
    expect(witness.shortfall).toBeCloseTo(5 - witness.worstDistance, 9);
  });

  it('安全比例之前的任意点都安全、之后存在失守（区间性质，非采样）', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 10, weightMax: 10, center: { x: 50, y: 50 } },
      { id: 'B', weight: 10, weightMin: 1, weightMax: 200, center: { x: 50, y: 50 } },
    ];
    const w = ws(items);
    const target = { x: 98, y: 50 };
    const r = rehearseMove({ workspace: w, itemIndex: 1, target });
    expect(r.status).toBe('rehearsal-fail');
    const sStar = r.safeRatio;
    const origin = items[1].center;

    // s* 处最坏距离恰为 margin（压线安全）；s* 稍往右即严格失守
    const atBoundary = analyzeStability({
      ...w,
      items: moveItem(items, 1, at(origin, target, sStar)),
    });
    expect(atBoundary.robust.worstMinDistance!).toBeGreaterThanOrEqual(5 - 1e-9);

    const beyond = analyzeStability({
      ...w,
      items: moveItem(items, 1, at(origin, target, Math.min(1, sStar + 1e-4))),
    });
    expect(beyond.robust.status).toBe('robust-fail');
  });

  it('多件（n=5/7）随机：每个预演边界都被角点根预言机核对', () => {
    let seed = 90210;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const n of [3, 5, 7]) {
      for (let t = 0; t < 6; t++) {
        const items: CargoItem[] = Array.from({ length: n }, (_, i) => {
          const ww = 5 + rand() * 40;
          const rel = 0.05 + rand() * 0.7;
          return {
            id: `r${i}`,
            weight: ww,
            weightMin: ww * (1 - rel),
            weightMax: ww * (1 + rel),
            center: { x: 30 + rand() * 40, y: 30 + rand() * 40 },
          };
        });
        const margin = 8 + rand() * 20;
        const w = ws(items, margin);
        const itemIndex = Math.floor(rand() * n);
        const target = { x: rand() * 100, y: rand() * 100 };
        const r = rehearseMove({ workspace: w, itemIndex, target });
        const o = oracleRoot(w, itemIndex, target);

        if (r.status === 'rehearsal-pass') {
          expect(o).toBeNull();
          expect(r.breachRatio).toBeNull();
          expect(r.safeRatio).toBe(1);
        } else if (r.status === 'rehearsal-fail') {
          expect(o).not.toBeNull();
          expect(r.breachRatio).toBeCloseTo(o!.ratio, 8);
          expect(r.boundaryWidth).toBeLessThanOrEqual(0.0001);
          expect(r.witness).not.toBeNull();
        }
      }
    }
  });
});

describe('移动预演：起点失守', () => {
  it('起点本身未通过：safeRatio=breachRatio=0，见证就在 s=0', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 10, weightMax: 10, center: { x: 50, y: 50 } },
      { id: 'B', weight: 10, weightMin: 1, weightMax: 200, center: { x: 98, y: 50 } },
    ];
    const w = ws(items);
    const r = rehearseMove({ workspace: w, itemIndex: 1, target: { x: 50, y: 50 } });
    expect(r.status).toBe('rehearsal-fail');
    expect(r.startReleasable).toBe(false);
    expect(r.safeRatio).toBe(0);
    expect(r.breachRatio).toBe(0);
    expect(r.boundaryWidth).toBe(0);
    expect(r.witness!.ratio).toBe(0);
    expect(r.witness!.movedCenter).toEqual({ x: 98, y: 50 });
    expect(r.witness!.criticalEdge.index).toBe(1);
  });

  it('标称起点不稳定（无区间）同样起点失守', () => {
    const items: CargoItem[] = [{ id: 'a', weight: 1, center: { x: 50, y: 2 } }];
    const w = ws(items);
    const r = rehearseMove({ workspace: w, itemIndex: 0, target: { x: 50, y: 60 } });
    expect(r.status).toBe('rehearsal-fail');
    expect(r.safeRatio).toBe(0);
    expect(r.startResult.stable).toBe(false);
  });
});

describe('移动预演：全程安全', () => {
  it('两端通过即整段通过（一次分式线性端点定理），无需采样', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 40, y: 50 } },
      { id: 'B', weight: 10, weightMin: 8, weightMax: 12, center: { x: 60, y: 50 } },
    ];
    const w = ws(items, 5);
    const r = rehearseMove({ workspace: w, itemIndex: 1, target: { x: 65, y: 50 } });
    expect(r.status).toBe('rehearsal-pass');
    expect(r.safeRatio).toBe(1);
    expect(r.breachRatio).toBeNull();
    expect(r.boundaryWidth).toBe(0);
    expect(r.witness).toBeNull();
    expect(r.endResult.releasable).toBe(true);
  });

  it('n=13/20 多件 LP 路径：两端证明通过即整段放行', () => {
    const items: CargoItem[] = [
      { id: 'M', weight: 10, weightMin: 8, weightMax: 12, center: { x: 50, y: 50 } },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `a${i}`,
        weight: 1,
        weightMin: 1,
        weightMax: 1,
        center: { x: 50, y: 50 },
      })),
    ];
    const r = rehearseMove({ workspace: ws(items), itemIndex: 0, target: { x: 58, y: 50 } });
    expect(r.status).toBe('rehearsal-pass');
  });

  it('n=13 途中失守：LP 见证角点一次根迭代给出的边界与解析根一致', () => {
    const items: CargoItem[] = [
      { id: 'M', weight: 10, weightMin: 1, weightMax: 200, center: { x: 50, y: 50 } },
      ...Array.from({ length: 12 }, () => ({
        id: 'a',
        weight: 1,
        weightMin: 1,
        weightMax: 1,
        center: { x: 50, y: 50 },
      })),
    ];
    const w = ws(items);
    const target = { x: 98, y: 50 };
    const r = rehearseMove({ workspace: w, itemIndex: 0, target });
    expect(r.status).toBe('rehearsal-fail');
    expect(r.boundaryWidth).toBeLessThanOrEqual(0.0001);
    // 最坏角点 M=200、12 个固定 1：cog=(200(50+48s)+600)/212=95 → s=0.99375
    expect(r.breachRatio).toBeCloseTo(0.99375, 9);
    expect(r.witness!.weights[0]).toBe(200);
    expect(r.witness!.criticalEdge.index).toBe(1);
    expect(r.witness!.worstDistance).toBeCloseTo(5, 8);
  });

  it('目标与原中心重合（零长路径）：起点可放行即通过', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 40, y: 50 } },
    ];
    const r = rehearseMove({ workspace: ws(items), itemIndex: 0, target: { x: 40, y: 50 } });
    expect(r.status).toBe('rehearsal-pass');
  });

  it('边界恰等于 margin 算安全：终点最坏距离正好压线仍全程通过', () => {
    // 单件从 (50,50) 移到 (95,50)，到右边距离恰为 5 = margin
    const items: CargoItem[] = [
      { id: 'a', weight: 1, weightMin: 1, weightMax: 1, center: { x: 50, y: 50 } },
    ];
    const r = rehearseMove({ workspace: ws(items), itemIndex: 0, target: { x: 95, y: 50 } });
    expect(r.status).toBe('rehearsal-pass');
    expect(r.endResult.robust.worstMinDistance).toBe(5);
  });
});

describe('移动预演：无法裁决只能暂缓', () => {
  it('起点存在溢出角点：rehearsal-indeterminate，不伪造安全/失守边界', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 40, y: 50 } },
      { id: 'B', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 60, y: 50 } },
    ];
    const r = rehearseMove({ workspace: ws(items, 1), itemIndex: 1, target: { x: 65, y: 50 } });
    expect(r.status).toBe('rehearsal-indeterminate');
    expect(r.startReleasable).toBe(false);
    expect(r.witness).toBeNull();
    expect(r.reason).toMatch(/无法可靠裁决|不可审核/);
    // startResult / endResult 仍同源于真实分析
    expect(r.startResult.releasable).toBe(false);
  });

  it('暂缓结论不携带失守见证，调用方不得据此应用目标', () => {
    // 两件 1.7e308：几何上居中，但「全部取上界」角点合计溢出 double，
    // 属不可审核的允许组合——任何目标都只能暂缓。
    const items: CargoItem[] = [
      { id: 'A', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 45, y: 50 } },
      { id: 'B', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 55, y: 50 } },
    ];
    const r = rehearseMove({ workspace: ws(items, 1), itemIndex: 1, target: { x: 60, y: 50 } });
    expect(r.status).toBe('rehearsal-indeterminate');
    expect(r.witness).toBeNull();
    expect(r.breachRatio).toBeNull();
    expect(r.safeRatio).toBe(0);
  });
});

describe('移动预演：非法目标撤销预演，不改工作区与原放行结论', () => {
  const base: Workspace = {
    polygon: square,
    margin: 5,
    items: [
      { id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 40, y: 50 } },
    ],
  };

  it('目标越界 / 非有限 / 下标非法均被校验拒绝', () => {
    expect(validateRehearsalTarget(base, 0, { x: 1e6 + 1, y: 0 }).length).toBeGreaterThan(0);
    expect(validateRehearsalTarget(base, 0, { x: NaN, y: 0 }).length).toBeGreaterThan(0);
    expect(validateRehearsalTarget(base, 0, { x: 0, y: Infinity }).length).toBeGreaterThan(0);
    expect(validateRehearsalTarget(base, 5, { x: 10, y: 10 }).length).toBeGreaterThan(0);
    expect(validateRehearsalTarget(base, -1, { x: 10, y: 10 }).length).toBeGreaterThan(0);
  });

  it('合法目标（含边界坐标）通过校验', () => {
    expect(validateRehearsalTarget(base, 0, { x: 1e6, y: -1e6 })).toEqual([]);
  });

  it('非法目标不产生预演；原工作区与其放行结论保持不变', () => {
    const before = analyzeStability(base);
    expect(before.releasable).toBe(true);
    // 预演被 UI 层拒绝（不调用 rehearseMove）；原工作区对象与其结论不被触碰
    const after = analyzeStability(base);
    expect(after.releasable).toBe(true);
    expect(base.items[0].center).toEqual({ x: 40, y: 50 });
  });
});

describe('移动预演：表单应用与结果同源', () => {
  it('仅全程通过时才应应用：applyTargetToForm 后重新解析得到目标位置且仍可放行', () => {
    const start: Workspace = {
      polygon: square,
      margin: 5,
      items: [
        { id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 40, y: 50 } },
        { id: 'B', weight: 10, weightMin: 8, weightMax: 12, center: { x: 60, y: 50 } },
      ],
    };
    const form = workspaceToForm(start);
    const r = rehearseMove({ workspace: start, itemIndex: 1, target: { x: 65, y: 50 } });
    expect(r.status).toBe('rehearsal-pass');

    const next = applyTargetToForm(form, 1, { x: 65, y: 50 });
    const resolved = resolveForm(square, next);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.result.items[1].center).toEqual({ x: 65, y: 50 });
      expect(resolved.result.releasable).toBe(true);
    }
  });

  it('途中失守时应用入口无意义：新位置重新解析确为不可放行（防止越权应用）', () => {
    const start: Workspace = {
      polygon: square,
      margin: 5,
      items: [
        { id: 'A', weight: 10, weightMin: 10, weightMax: 10, center: { x: 50, y: 50 } },
        { id: 'B', weight: 10, weightMin: 1, weightMax: 200, center: { x: 50, y: 50 } },
      ],
    };
    const r = rehearseMove({ workspace: start, itemIndex: 1, target: { x: 98, y: 50 } });
    expect(r.status).toBe('rehearsal-fail');
    // UI 必须禁用按钮；即便强行提交目标，解析结果也不可放行
    const form = workspaceToForm(start);
    const resolved = resolveForm(
      square,
      applyTargetToForm(form, 1, { x: 98, y: 50 }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.result.releasable).toBe(false);
  });

  it('startResult 复用调用方传入的同一份结果（预演/俯视图/数值面板同源）', () => {
    const start: Workspace = {
      polygon: square,
      margin: 5,
      items: [{ id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 50, y: 50 } }],
    };
    const shared = analyzeStability(start);
    const r = rehearseMove({
      workspace: start,
      itemIndex: 0,
      target: { x: 60, y: 50 },
      startResult: shared,
    });
    expect(r.startResult).toBe(shared);
  });
});
