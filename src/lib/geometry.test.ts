import { describe, expect, it } from 'vitest';
import {
  analyzeStability,
  checkStrictConvexCCW,
  cross,
  insetPolygon,
  signedDistanceToEdge,
  weightedCentroid,
} from './geometry';
import { parseWorkspace, parseWorkspaceJSON } from './parse';
import type { CargoItem, Point, Workspace } from './types';

const squareCCW: Point[] = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

function items(...spec: Array<[string, number, number, number]>): CargoItem[] {
  return spec.map(([id, weight, x, y]) => ({ id, weight, center: { x, y } }));
}

function ws(polygon: Point[], list: CargoItem[], margin = 0): Workspace {
  return { polygon, items: list, margin };
}

describe('cross', () => {
  it('逆时针转向为正，顺时针为负，共线为零', () => {
    expect(cross({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBe(1);
    expect(cross({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 })).toBe(-1);
    expect(cross({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 0 })).toBe(0);
  });
});

describe('checkStrictConvexCCW', () => {
  it('接受逆时针严格凸多边形', () => {
    expect(checkStrictConvexCCW(squareCCW).valid).toBe(true);
    expect(
      checkStrictConvexCCW([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
      ]).valid,
    ).toBe(true);
  });

  it('拒绝顶点过少', () => {
    expect(checkStrictConvexCCW([]).error).toBe('too-few-points');
    expect(
      checkStrictConvexCCW([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]).error,
    ).toBe('too-few-points');
  });

  it('拒绝重复顶点', () => {
    expect(
      checkStrictConvexCCW([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 0 },
        { x: 0, y: 4 },
      ]).error,
    ).toBe('duplicate-vertex');
  });

  it('拒绝共线连续顶点（非严格凸）', () => {
    expect(
      checkStrictConvexCCW([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ]).error,
    ).toBe('degenerate-edge');
  });

  it('拒绝顺时针多边形', () => {
    const clockwise = [...squareCCW].reverse();
    expect(checkStrictConvexCCW(clockwise).error).toBe('clockwise-or-degenerate');
  });

  it('拒绝局部凹陷的非凸多边形', () => {
    expect(
      checkStrictConvexCCW([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 2, y: 2 },
        { x: 0, y: 4 },
      ]).error,
    ).toBe('non-convex');
  });

  it('拒绝自交的五角星（局部叉积为正但全局不同侧）', () => {
    const star: Point[] = [];
    for (let i = 0; i < 5; i++) {
      const outer = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      star.push({ x: Math.cos(outer) * 2, y: Math.sin(outer) * 2 });
      const inner = outer + Math.PI / 5;
      star.push({ x: Math.cos(inner) * 0.8, y: Math.sin(inner) * 0.8 });
    }
    expect(checkStrictConvexCCW(star).valid).toBe(false);
  });

  it('接受旋转/平移后的凸多边形', () => {
    const rotated: Point[] = [
      { x: 10, y: 10 },
      { x: 12.828, y: 7.172 },
      { x: 15.657, y: 10 },
      { x: 12.828, y: 12.828 },
    ];
    expect(checkStrictConvexCCW(rotated).valid).toBe(true);
  });
});

describe('signedDistanceToEdge', () => {
  it('内部为正、边上为零、外部为负', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 0 };
    expect(signedDistanceToEdge({ x: 2, y: 3 }, a, b)).toBeCloseTo(3, 12);
    expect(signedDistanceToEdge({ x: 2, y: 0 }, a, b)).toBeCloseTo(0, 12);
    expect(signedDistanceToEdge({ x: 2, y: -2 }, a, b)).toBeCloseTo(-2, 12);
  });

  it('斜边距离按真实边长归一化', () => {
    const d = signedDistanceToEdge(
      { x: 0, y: 1 },
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    );
    // |叉积|/边长 = 3/5
    expect(d).toBeCloseTo(0.6, 12);
  });
});

describe('weightedCentroid', () => {
  it('等权时退化为算术平均', () => {
    const { cog, totalWeight } = weightedCentroid(
      items(['a', 1, 0, 0], ['b', 1, 4, 8]),
    );
    expect(cog.x).toBeCloseTo(2, 12);
    expect(cog.y).toBeCloseTo(4, 12);
    expect(totalWeight).toBeCloseTo(2, 12);
  });

  it('按重量加权', () => {
    const { cog } = weightedCentroid(
      items(['a', 3, 0, 0], ['b', 1, 4, 0]),
    );
    expect(cog.x).toBeCloseTo(1, 12);
    expect(cog.y).toBeCloseTo(0, 12);
  });

  it('极端重量下保持有限（缩放兜底）', () => {
    const { cog } = weightedCentroid(
      items(
        ['a', 1e308, 0, 0],
        ['b', 1e308, 10, 0],
      ),
    );
    expect(Number.isFinite(cog.x)).toBe(true);
    expect(cog.x).toBeCloseTo(5, 10);
  });
});

describe('insetPolygon', () => {
  it('margin 为 0 时原样返回', () => {
    expect(insetPolygon(squareCCW, 0)).toBe(squareCCW);
  });

  it('正方形各向内缩 margin', () => {
    const region = insetPolygon(squareCCW, 1);
    const xs = region.map((p) => p.x).sort((a, b) => a - b);
    const ys = region.map((p) => p.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(1, 10);
    expect(xs[xs.length - 1]).toBeCloseTo(3, 10);
    expect(ys[0]).toBeCloseTo(1, 10);
    expect(ys[ys.length - 1]).toBeCloseTo(3, 10);
    // 内缩结果仍是凸四边形
    expect(region.length).toBe(4);
  });

  it('margin 超过内切余量时安全区塌缩为空', () => {
    expect(insetPolygon(squareCCW, 5).length).toBe(0);
  });
});

describe('analyzeStability', () => {
  it('重心在正中心且 margin=0 时 STABLE', () => {
    const r = analyzeStability(ws(squareCCW, items(['a', 1, 2, 2])));
    expect(r.stable).toBe(true);
    expect(r.shortfall).toBe(0);
    expect(r.minDistance).toBeCloseTo(2, 12);
    expect(r.criticalEdge.index).toBe(0);
  });

  it('重心到边的最小距离小于 margin 时 UNSTABLE，并给出最危险边与短缺量', () => {
    const r = analyzeStability(
      ws(squareCCW, items(['a', 1, 2, 0.5]), 1),
    );
    expect(r.stable).toBe(false);
    expect(r.minDistance).toBeCloseTo(0.5, 12);
    expect(r.shortfall).toBeCloseTo(0.5, 12);
    // 重心贴近底边（边 0：(0,0)→(4,0)）
    expect(r.criticalEdge.index).toBe(0);
  });

  it('重心越出支撑边时有符号距离为负，短缺量 = margin - 负距离', () => {
    const r = analyzeStability(
      ws(squareCCW, items(['a', 1, 2, -1]), 0.5),
    );
    expect(r.stable).toBe(false);
    expect(r.minDistance).toBeCloseTo(-1, 12);
    expect(r.shortfall).toBeCloseTo(1.5, 12);
  });

  it('恰好落在 margin 边界上判为 STABLE（未舍入比较，无 epsilon）', () => {
    const r = analyzeStability(
      ws(squareCCW, items(['a', 1, 2, 1]), 1),
    );
    expect(r.stable).toBe(true);
  });

  it('加权移动重心会改变最危险边', () => {
    const nearRight = analyzeStability(
      ws(squareCCW, items(['a', 9, 3.9, 2], ['b', 1, 0.1, 2])),
    );
    expect(nearRight.criticalEdge.index).toBe(1); // 右边 (4,0)→(4,4)
    // 重心 x = (9*3.9 + 0.1)/10 = 3.52，到右边距离 0.48
    expect(nearRight.minDistance).toBeCloseTo(0.48, 10);
  });

  it('结果包含全部边距离且最小值与 criticalEdge 一致', () => {
    const r = analyzeStability(ws(squareCCW, items(['a', 1, 2.5, 1.2]), 0));
    expect(r.edges.length).toBe(4);
    const m = Math.min(...r.edges.map((e) => e.signedDistance));
    expect(m).toBe(r.criticalEdge.signedDistance);
    expect(m).toBe(r.minDistance);
  });
});

describe('parseWorkspace / 整批拒绝', () => {
  const valid = {
    polygon: [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ],
    margin: 0.2,
    items: [{ id: 'a', weight: 10, center: [2, 2] }],
  };

  it('接受合法数据（数组点与对象点均可）', () => {
    const r = parseWorkspace(valid);
    expect(r.ok).toBe(true);
    const r2 = parseWorkspace({
      ...valid,
      items: [{ id: 'a', weight: 10, center: { x: 2, y: 2 } }],
    });
    expect(r2.ok).toBe(true);
  });

  it('拒绝顶层未知字段', () => {
    const r = parseWorkspace({ ...valid, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/未知字段/);
  });

  it('拒绝货物未知字段', () => {
    const r = parseWorkspace({
      ...valid,
      items: [{ id: 'a', weight: 10, center: [2, 2], color: 'red' }],
    });
    expect(r.ok).toBe(false);
  });

  it('拒绝重复顶点、非凸、退化多边形', () => {
    const dup = { ...valid, polygon: [[0, 0], [4, 0], [4, 0], [0, 4]] };
    expect(parseWorkspace(dup).ok).toBe(false);

    const clockwise = {
      ...valid,
      polygon: [
        [0, 0],
        [0, 4],
        [4, 4],
        [4, 0],
      ],
    };
    expect(parseWorkspace(clockwise).ok).toBe(false);

    const collinear = {
      ...valid,
      polygon: [
        [0, 0],
        [2, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
    };
    expect(parseWorkspace(collinear).ok).toBe(false);
  });

  it('拒绝非法重量：零、负、NaN、Infinity、字符串', () => {
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
      const r = parseWorkspace({
        ...valid,
        items: [{ id: 'a', weight, center: [2, 2] }],
      });
      expect(r.ok).toBe(false);
    }
  });

  it('拒绝重复 id、空 id', () => {
    expect(
      parseWorkspace({
        ...valid,
        items: [
          { id: 'a', weight: 1, center: [1, 1] },
          { id: 'a', weight: 1, center: [2, 2] },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseWorkspace({
        ...valid,
        items: [{ id: '  ', weight: 1, center: [1, 1] }],
      }).ok,
    ).toBe(false);
  });

  it('拒绝件数越界（0 件与 201 件）', () => {
    expect(parseWorkspace({ ...valid, items: [] }).ok).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: `i${i}`,
      weight: 1,
      center: [2, 2],
    }));
    expect(parseWorkspace({ ...valid, items: many }).ok).toBe(false);
    const max = many.slice(0, 200);
    expect(parseWorkspace({ ...valid, items: max }).ok).toBe(true);
  });

  it('拒绝坐标越界与非有限坐标', () => {
    expect(
      parseWorkspace({
        ...valid,
        polygon: [
          [0, 0],
          [1e6 + 1, 0],
          [4, 4],
          [0, 4],
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseWorkspace({
        ...valid,
        items: [{ id: 'a', weight: 1, center: [Number.NaN, 2] }],
      }).ok,
    ).toBe(false);
  });

  it('接受边界值 ±1e6', () => {
    const r = parseWorkspace({
      polygon: [
        [-1e6, -1e6],
        [1e6, -1e6],
        [1e6, 1e6],
        [-1e6, 1e6],
      ],
      items: [
        { id: 'a', weight: 1, center: [-1e6, 1e6] },
        { id: 'b', weight: 1, center: [1e6, -1e6] },
      ],
      margin: 0,
    });
    expect(r.ok).toBe(true);
  });

  it('拒绝负数或非法 margin，缺省 margin=0', () => {
    expect(parseWorkspace({ ...valid, margin: -0.0001 }).ok).toBe(false);
    expect(parseWorkspace({ ...valid, margin: '1' }).ok).toBe(false);
    const rest = { polygon: valid.polygon, items: valid.items };
    const r = parseWorkspace(rest);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workspace.margin).toBe(0);
  });

  it('parseWorkspaceJSON 拒绝语法错误文本', () => {
    const r = parseWorkspaceJSON('{ polygon: ');
    expect(r.ok).toBe(false);
  });

  it('失败时一次性收集多条错误', () => {
    const r = parseWorkspace({
      polygon: 'nope',
      items: [{ id: 'a', weight: -1, center: [2, 2] }],
      margin: -3,
      bogus: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });
});
