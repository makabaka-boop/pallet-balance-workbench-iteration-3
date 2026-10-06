import { describe, expect, it } from 'vitest';
import { analyzeStability } from './geometry';
import {
  applyMoveTarget,
  previewMovement,
  validateMoveTarget,
} from './movement';
import { itemRange } from './robust';
import type { CargoItem, Point, Workspace } from './types';

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

function distance(poly: Point[], edgeIndex: number, p: Point): number {
  const a = poly[edgeIndex];
  const b = poly[(edgeIndex + 1) % poly.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return (dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.hypot(dx, dy);
}

function workspace(items: CargoItem[], margin = 40): Workspace {
  return { polygon: square, items, margin };
}

function endpointWorstDistance(
  ws: Workspace,
  movedItem: number,
  target: Point,
  ratio: number,
): number {
  const source = ws.items[movedItem].center;
  const moved: CargoItem = {
    ...ws.items[movedItem],
    center: {
      x: source.x + ratio * (target.x - source.x),
      y: source.y + ratio * (target.y - source.y),
    },
  };
  const items = ws.items.map((it, i) => (i === movedItem ? moved : it));
  let worst = Infinity;
  const count = 1 << items.length;
  for (let mask = 0; mask < count; mask++) {
    const weights = items.map((it, i) => {
      const r = itemRange(it);
      return r.min + ((mask >> i) & 1) * (r.max - r.min);
    });
    let sx = 0;
    let sy = 0;
    let sw = 0;
    items.forEach((it, i) => {
      sx += weights[i] * it.center.x;
      sy += weights[i] * it.center.y;
      sw += weights[i];
    });
    const cog = { x: sx / sw, y: sy / sw };
    for (let e = 0; e < square.length; e++) worst = Math.min(worst, distance(square, e, cog));
  }
  return worst;
}

describe('单件货物直线移动预演', () => {
  it('起点可放行、途中失守：用端点枚举给出宽度 ≤ 1e-4 的安全/失守比例边界和可复算见证', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 9, weightMax: 11, center: { x: 40, y: 50 } },
      { id: 'B', weight: 10, weightMin: 9, weightMax: 11, center: { x: 50, y: 50 } },
    ];
    const ws = workspace(items);
    expect(analyzeStability(ws).releasable).toBe(true);

    const { preview, displayResult } = previewMovement(ws, 'A', { x: 99, y: 50 });
    expect(preview.status).toBe('fails-after-start');
    expect(preview.safeRatio).not.toBeNull();
    expect(preview.unsafeRatio).not.toBeNull();
    expect(preview.boundaryWidth!).toBeLessThanOrEqual(0.0001);
    expect(preview.boundaryWidth!).toBeGreaterThan(0);
    expect(displayResult.movement).toBe(preview);

    const safe = preview.safeRatio!;
    const unsafe = preview.unsafeRatio!;
    expect(endpointWorstDistance(ws, 0, { x: 99, y: 50 }, safe)).toBeGreaterThanOrEqual(40);
    expect(endpointWorstDistance(ws, 0, { x: 99, y: 50 }, unsafe)).toBeLessThan(40);

    const witness = preview.witness!;
    expect(witness.ratio).toBe(unsafe);
    witness.weights.forEach((w, i) => {
      const range = itemRange(items[i]);
      expect(w === range.min || w === range.max).toBe(true);
    });
    let sx = 0;
    let sy = 0;
    let sw = 0;
    // witness 位于 unsafe 比例；displayResult.items 已是该比例的位置，直接复算
    displayResult.items.forEach((it, i) => {
      const x = it.center.x;
      const y = it.center.y;
      sx += witness.weights[i] * x;
      sy += witness.weights[i] * y;
      sw += witness.weights[i];
    });
    expect(witness.cog.x).toBeCloseTo(sx / sw, 12);
    expect(witness.cog.y).toBeCloseTo(sy / sw, 12);
    expect(witness.criticalEdge.signedDistance).toBeCloseTo(
      distance(square, witness.criticalEdge.index, witness.cog),
      12,
    );
    expect(witness.minDistance).toBeLessThan(40);
  });

  it('边界恰等于 margin：安全侧算通过，下一已证失守侧严格不足', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 1, center: { x: 30, y: 50 } },
      { id: 'B', weight: 1, center: { x: 50, y: 50 } },
    ];
    const ws = workspace(items, 30);
    const target = { x: 100, y: 50 };
    const { preview } = previewMovement(ws, 'A', target);
    // 真实边界 t=6/7：cog x=70，右边距离恰为 margin=30；边界相等仍属安全侧。
    expect(preview.status).toBe('fails-after-start');
    expect(endpointWorstDistance(ws, 0, target, preview.safeRatio!)).toBeGreaterThanOrEqual(30);
    expect(endpointWorstDistance(ws, 0, target, preview.unsafeRatio!)).toBeLessThan(30);
    expect(preview.boundaryWidth!).toBeLessThanOrEqual(0.0001);
  });

  it('起点失守：返回 start-fail，不伪造边界，且结果见证可复算', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 100, center: { x: 95, y: 50 } },
      { id: 'B', weight: 1, center: { x: 10, y: 50 } },
    ];
    const ws = workspace(items);
    const start = analyzeStability(ws);
    expect(start.releasable).toBe(false);

    const { preview } = previewMovement(ws, 'B', { x: 90, y: 50 });
    expect(preview.status).toBe('start-fail');
    expect(preview.safeRatio).toBeNull();
    expect(preview.unsafeRatio).toBeNull();
    expect(preview.boundaryWidth).toBeNull();
    expect(preview.witness?.ratio).toBe(0);
    expect(preview.witness?.minDistance).toBeLessThan(40);
  });

  it('全程安全：两端鲁棒通过即可由凹性证明整条路径，safeRatio=1', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 30, y: 50 } },
      { id: 'B', weight: 10, weightMin: 8, weightMax: 12, center: { x: 55, y: 50 } },
    ];
    const ws = workspace(items, 20);
    const { preview, displayResult } = previewMovement(ws, 'A', { x: 45, y: 50 });
    expect(preview.status).toBe('all-safe');
    expect(preview.safeRatio).toBe(1);
    expect(preview.unsafeRatio).toBeNull();
    expect(preview.witness).toBeNull();
    expect(displayResult.releasable).toBe(true);
  });

  it('存在不可审核溢出量时只能暂缓，不得返回可放行或失守边界', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 30, y: 50 } },
      { id: 'B', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 55, y: 50 } },
    ];
    const ws = workspace(items, 1);
    const { preview, displayResult } = previewMovement(ws, 'A', { x: 45, y: 50 });
    expect(preview.status).toBe('indeterminate');
    expect(preview.safeRatio).toBeNull();
    expect(preview.unsafeRatio).toBeNull();
    expect(preview.witness).toBeNull();
    expect(displayResult.releasable).toBe(false);
  });

  it('非法目标撤销预演但不改变工作区；只有全程安全可应用', () => {
    const items: CargoItem[] = [
      { id: 'A', weight: 10, center: { x: 30, y: 50 } },
      { id: 'B', weight: 10, center: { x: 60, y: 50 } },
    ];
    const ws = workspace(items, 10);
    const snapshot = JSON.stringify(ws);
    expect(validateMoveTarget(ws, 'missing', { x: 40, y: 50 })).toHaveLength(1);
    expect(validateMoveTarget(ws, 'A', { x: NaN, y: 50 })).toHaveLength(1);
    expect(validateMoveTarget(ws, 'A', { x: 1000001, y: 50 })).toHaveLength(1);
    expect(JSON.stringify(ws)).toBe(snapshot);

    const bad = previewMovement(ws, 'A', { x: 200, y: 50 });
    expect(bad.preview.status).not.toBe('all-safe');
    expect(() => applyMoveTarget(ws, 'A', bad.preview.target)).not.toThrow();
    const appliedSource = applyMoveTarget(ws, 'A', bad.preview.target);
    expect(appliedSource.items[0].center.x).toBe(200);
    expect(ws.items[0].center.x).toBe(30);

    const good = previewMovement(ws, 'A', { x: 40, y: 50 });
    expect(good.preview.status).toBe('all-safe');
    const next = applyMoveTarget(ws, 'A', good.preview.target);
    expect(next.items[0].center).toEqual({ x: 40, y: 50 });
    expect(ws.items[0].center).toEqual({ x: 30, y: 50 });
  });
});
