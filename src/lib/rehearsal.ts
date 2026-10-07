/**
 * 单件货物「移动预演」。
 *
 * 把一件货物从原中心沿直线挪到目标中心：路径参数 s ∈ [0,1]，
 * c_j(s) = c_j(0) + s·(c_j(1) − c_j(0))，其余货物不动。
 *
 * 关键的区间性质（完整证明，而非采样）
 * ------------------------------------
 * 对支撑边 e（顶点 v→w，长度 L_e）和任意固定的允许重量组合 w（重量盒角点 k），
 * 重心到该边的有符号距离满足 margin 等价于
 *
 *   Q_{e,k}(s) = Σ_i w_i·cross(v,w,c_i(s)) − margin·L_e·Σ_i w_i ≥ 0。
 *
 * 只有被移动货物的中心随 s 线性变化，而 cross 对动点是线性的，故 Q_{e,k}(s)
 * 是 s 的一次函数（分母 Σw_i 恒正、与 s 无关）。于是：
 *
 * 1. 一次函数在区间 [0,1] 上非负 ⟺ 两端点非负——整段路径对该角点安全，
 *    只需证明 s=0 与 s=1 两个端点；
 * 2. 若起点非负、终点为负，唯一的失守比例可直接由一次方程求出：
 *    s* = Q(0) / (Q(0) − Q(1))，不存在采样漏检；
 * 3. 鲁棒要求「所有角点」安全：对每个 (边, 角点) 取最早的 s* 即全局首次失守点。
 *
 * 少件货物（≤ EXACT_CORNER_LIMIT）枚举全部 2ⁿ 个角点直接求所有根；
 * 多件货物利用同一端点定理：两端点经 Charnes–Cooper LP 证明通过即整段通过，
 * 终点失守时用 LP 见证角点的一次根 + 根点复证迭代定位边界。
 *
 * 边界恰等于 margin 算安全；任一点数值无法可靠裁决时结论只能是「暂缓」。
 */
import { analyzeStability, cross } from './geometry';
import { EXACT_CORNER_LIMIT, buildWitness, itemRange } from './robust';
import { COORD_BOUND } from './parse';
import {
  BREACH_WIDTH_TOLERANCE,
  type CargoItem,
  type MoveRehearsal,
  type Point,
  type RehearsalWitness,
  type StabilityResult,
  type Workspace,
} from './types';

/** 边界复证的数值容差（距离相对量，远宽于 ~1e-13 的舍入噪声） */
const BOUNDARY_REL_TOL = 1e-9;

/**
 * 校验预演目标：被移动货物下标合法、目标中心为 |坐标| ≤ 1e6 的有限数。
 * 非法目标由调用方撤销预演，且不改工作区与既有放行结论。
 */
export function validateRehearsalTarget(
  ws: Workspace,
  itemIndex: number,
  target: Point,
): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= ws.items.length) {
    errors.push('移动预演：必须选择一件货物');
  }
  if (!Number.isFinite(target.x) || Math.abs(target.x) > COORD_BOUND) {
    errors.push(`移动预演：目标 X 必须是绝对值不超过 1e6 的有限数`);
  }
  if (!Number.isFinite(target.y) || Math.abs(target.y) > COORD_BOUND) {
    errors.push(`移动预演：目标 Y 必须是绝对值不超过 1e6 的有限数`);
  }
  return errors;
}

function lerp(a: number, b: number, s: number): number {
  return a + (b - a) * s;
}

function itemsAt(
  items: CargoItem[],
  itemIndex: number,
  target: Point,
  s: number,
): CargoItem[] {
  const o = items[itemIndex].center;
  const c: Point = { x: lerp(o.x, target.x, s), y: lerp(o.y, target.y, s) };
  return items.map((it, i) => (i === itemIndex ? { ...it, center: c } : it));
}

/** 该结论是否存在无法裁决/不可审核的量（告警或 LP 未裁决） */
function isBlocked(res: StabilityResult): boolean {
  return res.warnings.length > 0 || res.robust.status === 'indeterminate';
}

/** 组装首次失守点的可复算见证 */
function makeWitness(
  ws: Workspace,
  itemIndex: number,
  target: Point,
  ratio: number,
  weights: number[],
): RehearsalWitness {
  const moved = itemsAt(ws.items, itemIndex, target, ratio);
  const movedCenter = moved[itemIndex].center;
  const w = buildWitness(ws.polygon, moved, weights, ws.margin);
  const nominalWeights = ws.items.map((it) => it.weight);
  // 标称重心按 buildWitness 同一套（含溢出归一化）逻辑复算
  const nominal = buildWitness(ws.polygon, moved, nominalWeights, ws.margin);
  return {
    ratio,
    movedCenter,
    nominalCog: nominal.cog,
    weights: w.weights,
    cog: w.cog,
    totalWeight: w.totalWeight,
    criticalEdge: w.criticalEdge,
    worstDistance: w.minDistance,
    shortfall: w.shortfall,
  };
}

function boundaryTol(margin: number, d: number): number {
  return BOUNDARY_REL_TOL * Math.max(1, Math.abs(margin), Math.abs(d));
}

interface CornerRoot {
  ratio: number;
  mask: number;
  edgeIndex: number;
}

/**
 * 少件货物：枚举全部 2ⁿ 个重量角点，对每条边把 Q_{e,k}(s) 的一次根全部求出，
 * 取最早者。本身即为严格证明（独立于 LP 路径）。
 *
 * 重量按全局最大重量归一化求和，允许 1e308 级重量；margin·len 项同时归一化，
 * 符号不变。
 */
function earliestCornerRoot(
  ws: Workspace,
  itemIndex: number,
  origin: Point,
  target: Point,
): CornerRoot | null {
  const { polygon, items, margin } = ws;
  const ranges = items.map(itemRange);
  const n = items.length;
  const scaleW = Math.max(1, ...ranges.map((r) => Math.max(r.min, r.max)));

  let best: CornerRoot | null = null;
  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    const wNorm = ranges.map(
      (r, i) => (r.min + ((mask >> i) & 1) * (r.max - r.min)) / scaleW,
    );
    for (let e = 0; e < polygon.length; e++) {
      const v = polygon[e];
      const wv = polygon[(e + 1) % polygon.length];
      const len = Math.hypot(wv.x - v.x, wv.y - v.y);
      const mlen = margin * len;

      // Q(0) = Σ w̃_i·(cross_i(0) − margin·len)
      let q0 = 0;
      for (let i = 0; i < n; i++) {
        q0 += wNorm[i] * (cross(v, wv, items[i].center) - mlen);
      }
      // 只有被移动货物有斜率：w̃_j·(cross(target) − cross(origin))
      const slope =
        wNorm[itemIndex] *
        (cross(v, wv, target) - cross(v, wv, origin));
      const q1 = q0 + slope;

      let ratio: number;
      if (q0 < 0) {
        // 起点即失守（外层应已判为起点失败；防御性保留）
        ratio = 0;
      } else if (q1 < 0) {
        // 一次函数在 (0,1] 内由正转负：唯一根
        ratio = q0 / (q0 - q1);
        if (!(ratio >= 0 && ratio <= 1)) continue; // 数值异常：交给调用方暂缓
      } else {
        continue; // 该 (边,角点) 全程非负
      }

      if (
        best === null ||
        ratio < best.ratio ||
        (ratio === best.ratio && e < best.edgeIndex) ||
        (ratio === best.ratio && e === best.edgeIndex && mask < best.mask)
      ) {
        best = { ratio, mask, edgeIndex: e };
      }
    }
  }
  return best;
}

/** 由见证角点重量与其首先失守边，反解该角点 Q(s) 的一次根（多件迭代用） */
function cornerRootFromWeights(
  ws: Workspace,
  itemIndex: number,
  origin: Point,
  target: Point,
  weights: number[],
  edgeIndex: number,
): number | null {
  const { polygon, items, margin } = ws;
  const v = polygon[edgeIndex];
  const wv = polygon[(edgeIndex + 1) % polygon.length];
  const len = Math.hypot(wv.x - v.x, wv.y - v.y);
  let q0 = 0;
  for (let i = 0; i < items.length; i++) {
    q0 += weights[i] * (cross(v, wv, items[i].center) - margin * len);
  }
  const slope =
    weights[itemIndex] * (cross(v, wv, target) - cross(v, wv, origin));
  const q1 = q0 + slope;
  if (q0 - q1 === 0) return null;
  const ratio = q0 / (q0 - q1);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : null;
}

export interface RehearsalInput {
  workspace: Workspace;
  itemIndex: number;
  target: Point;
  /** 调用方（编辑器）已算好的起点结果，保证预演/俯视图/数值面板同一对象 */
  startResult?: StabilityResult;
}

/**
 * 执行单件货物移动预演。
 * 输入工作区必须合法（目标合法性由 validateRehearsalTarget 先行校验）。
 */
export function rehearseMove(input: RehearsalInput): MoveRehearsal {
  const { workspace: ws, itemIndex, target } = input;
  const origin = { ...ws.items[itemIndex].center };
  const margin = ws.margin;

  const startResult = input.startResult ?? analyzeStability(ws);
  const endResult = analyzeStability({
    ...ws,
    items: itemsAt(ws.items, itemIndex, target, 1),
  });

  const base = {
    itemIndex,
    target: { ...target },
    origin,
    margin,
    startResult,
    endResult,
  };

  const answer = (
    fields: Partial<MoveRehearsal>,
  ): MoveRehearsal => {
    const safeRatio = fields.safeRatio ?? 0;
    const breachRatio = fields.breachRatio === undefined ? null : fields.breachRatio;
    return {
      ...base,
      status: fields.status ?? 'rehearsal-indeterminate',
      startReleasable: fields.startReleasable ?? false,
      safeRatio,
      breachRatio,
      boundaryWidth:
        fields.boundaryWidth ??
        (breachRatio !== null ? breachRatio - safeRatio : 0),
      witness: fields.witness ?? null,
      reason: fields.reason ?? null,
    };
  };

  /* ---- 起点：无法裁决/不可审核 ---- */
  if (isBlocked(startResult)) {
    return answer({
      status: 'rehearsal-indeterminate',
      reason:
        '起点位置即存在无法可靠裁决或不可审核的量（重量区间求解未过交叉校验／合计重量溢出等），' +
        '路径分析无法开始：只能暂缓，禁止按预演放行。',
    });
  }

  /* ---- 起点即失守：无边界可谈，见证就在 s=0 ---- */
  if (!startResult.releasable) {
    const sw = startResult.robust.witness;
    return answer({
      status: 'rehearsal-fail',
      safeRatio: 0,
      breachRatio: 0,
      boundaryWidth: 0,
      witness: sw
        ? makeWitness(ws, itemIndex, target, 0, sw.weights)
        : null,
      reason: '起点位置本身未通过标称或鲁棒稳定性，不得起运。',
    });
  }

  // 起点可放行
  /* ---- 终点无法裁决：整段路径只能暂缓（任一点无法裁决都不能放行） ---- */
  if (isBlocked(endResult)) {
    return answer({
      status: 'rehearsal-indeterminate',
      startReleasable: true,
      reason:
        '起点可放行，但目标位置（路径终点）的重量区间稳定性无法可靠裁决或存在不可审核量；' +
        '路径上任一点无法裁决都只能提示暂缓，禁止应用目标位置。',
    });
  }

  const n = ws.items.length;

  /* ---- 少件：2ⁿ 全角点根枚举（完整证明 + 独立核对端点结论） ---- */
  if (n <= EXACT_CORNER_LIMIT) {
    const root = earliestCornerRoot(ws, itemIndex, origin, target);

    if (endResult.releasable) {
      // 端点定理 + 枚举双重确认：枚举不应找到任何严格失守根
      if (root !== null && root.ratio < 1) {
        // 端点结论与角点根核对不一致：不猜测，暂缓
        return answer({
          status: 'rehearsal-indeterminate',
          startReleasable: true,
          reason:
            `路径角点根枚举（s=${root.ratio}，边 #${root.edgeIndex}）与终点可放行结论不一致，` +
            '数值上无法可靠裁决：暂缓放行。',
        });
      }
      return answer({
        status: 'rehearsal-pass',
        startReleasable: true,
        safeRatio: 1,
        breachRatio: null,
        boundaryWidth: 0,
      });
    }

    // 终点失守：枚举必须给出 (0,1] 内的最早失守根
    if (root === null) {
      return answer({
        status: 'rehearsal-indeterminate',
        startReleasable: true,
        reason:
          '终点已证失守，但角点根枚举未找到一致的失守比例，端点结论无法相互复算：暂缓放行。',
      });
    }

    const weights = ws.items.map(
      (it, i) =>
        itemRange(it).min +
        ((root.mask >> i) & 1) * (itemRange(it).max - itemRange(it).min),
    );
    const witness = makeWitness(ws, itemIndex, target, root.ratio, weights);
    const tol = boundaryTol(margin, witness.worstDistance);

    // 边界复证：见证点最坏距离必须恰为 margin（边界压线按安全计）
    if (Math.abs(witness.worstDistance - margin) > tol) {
      return answer({
        status: 'rehearsal-indeterminate',
        startReleasable: true,
        safeRatio: root.ratio,
        breachRatio: root.ratio,
        boundaryWidth: 0,
        witness,
        reason:
          `失守比例 s=${root.ratio} 处的复算距离 ${witness.worstDistance} 与 margin ${margin} ` +
          '之差超出数值容差，边界无法可靠裁决：暂缓放行。',
      });
    }

    return answer({
      status: 'rehearsal-fail',
      startReleasable: true,
      safeRatio: root.ratio,
      breachRatio: root.ratio,
      boundaryWidth: 0,
      witness,
    });
  }

  /* ---- 多件：端点 LP 证明 + 失守时见证角点一次根迭代 ---- */
  if (endResult.releasable) {
    // 两端对全部角点证明非负（LP 已对整盒取最小），一次函数非负 ⟹ 整段非负
    return answer({
      status: 'rehearsal-pass',
      startReleasable: true,
      safeRatio: 1,
      breachRatio: null,
      boundaryWidth: 0,
    });
  }

  const probe = (s: number): StabilityResult =>
    analyzeStability({ ...ws, items: itemsAt(ws.items, itemIndex, target, s) });

  let ratio = 1;
  let res: StabilityResult = endResult;
  for (let iter = 0; iter < 12; iter++) {
    if (isBlocked(res)) {
      return answer({
        status: 'rehearsal-indeterminate',
        startReleasable: true,
        reason: `路径比例 s=${ratio} 处的重量区间稳定性无法可靠裁决：只能暂缓放行。`,
      });
    }
    const d = res.robust.worstMinDistance;
    if (d === null) {
      return answer({
        status: 'rehearsal-indeterminate',
        startReleasable: true,
        reason: `路径比例 s=${ratio} 处最坏距离缺失：暂缓放行。`,
      });
    }
    const tol = boundaryTol(margin, d);
    if (Math.abs(d - margin) <= tol) break; // 根点复证成功

    const vw = res.robust.witness;
    if (!vw) {
      return answer({
        status: 'rehearsal-indeterminate',
        startReleasable: true,
        reason: `路径比例 s=${ratio} 处失守但无见证角点：暂缓放行。`,
      });
    }
    const next = cornerRootFromWeights(
      ws,
      itemIndex,
      origin,
      target,
      vw.weights,
      vw.criticalEdge.index,
    );
    if (next === null || !(next < ratio)) {
      // 无法进一步收窄：给出宽度 ≤ 0.0001 的 bracket，否则暂缓
      const lo = Math.max(0, ratio - BREACH_WIDTH_TOLERANCE);
      if (ratio - lo <= BREACH_WIDTH_TOLERANCE) {
        const witness = makeWitness(ws, itemIndex, target, ratio, vw.weights);
        return answer({
          status: 'rehearsal-fail',
          startReleasable: true,
          safeRatio: lo,
          breachRatio: ratio,
          boundaryWidth: ratio - lo,
          witness,
        });
      }
      return answer({
        status: 'rehearsal-indeterminate',
        startReleasable: true,
        reason: `无法把失守比例收窄到 ${BREACH_WIDTH_TOLERANCE} 以内：暂缓放行。`,
      });
    }
    ratio = next;
    res = probe(ratio);
  }

  const vw = res.robust.witness;
  if (!vw) {
    return answer({
      status: 'rehearsal-indeterminate',
      startReleasable: true,
      reason: `失守比例 s=${ratio} 处缺少可复算见证：暂缓放行。`,
    });
  }
  const witness = makeWitness(ws, itemIndex, target, ratio, vw.weights);
  const tol = boundaryTol(margin, witness.worstDistance);
  if (Math.abs(witness.worstDistance - margin) > tol) {
    return answer({
      status: 'rehearsal-indeterminate',
      startReleasable: true,
      safeRatio: ratio,
      breachRatio: ratio,
      boundaryWidth: 0,
      witness,
      reason:
        `失守比例 s=${ratio} 处的复算距离 ${witness.worstDistance} 与 margin ${margin} ` +
        '之差超出数值容差：暂缓放行。',
    });
  }
  return answer({
    status: 'rehearsal-fail',
    startReleasable: true,
    safeRatio: ratio,
    breachRatio: ratio,
    boundaryWidth: 0,
    witness,
  });
}
