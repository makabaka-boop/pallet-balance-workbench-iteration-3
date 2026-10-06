import { analyzeStability } from './geometry';
import { COORD_BOUND } from './parse';
import type { StabilityResult, Workspace } from './types';

/** 编辑表单中的单行文本（未提交的原始输入也保留为字符串） */
export interface ItemDraft {
  id: string;
  weight: string;
  /** 可选重量下界文本；空串表示未填写（该端沿用标称重量） */
  weightMin: string;
  /** 可选重量上界文本；空串表示未填写（该端沿用标称重量） */
  weightMax: string;
  x: string;
  y: string;
}

export interface FormState {
  margin: string;
  items: ItemDraft[];
}

export function workspaceToForm(ws: Workspace): FormState {
  return {
    margin: String(ws.margin),
    items: ws.items.map((it) => ({
      id: it.id,
      weight: String(it.weight),
      // 区间端点仅在导入数据中显式给出时回填；空白表示确定重量
      weightMin: it.weightMin !== undefined ? String(it.weightMin) : '',
      weightMax: it.weightMax !== undefined ? String(it.weightMax) : '',
      x: String(it.center.x),
      y: String(it.center.y),
    })),
  };
}

export type ResolvedForm =
  | { ok: true; result: StabilityResult }
  | { ok: false; errors: string[] };

/** 解析一个非空数值输入；空串或非有限数返回 NaN */
function parseNum(text: string): number {
  if (text.trim() === '') return NaN;
  const v = Number(text);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * 把当前编辑表单解析为工作区并立即执行稳定性分析。
 * 任何字段非法（含重量区间：非正、下界＞上界、标称重量不在区间内）即判定失败，
 * 调用方据此撤销旧结论——数值面板与 SVG 只可能同时展示同一份成功结果，
 * 或同时不展示结论。
 */
export function resolveForm(polygon: Workspace['polygon'], form: FormState): ResolvedForm {
  const errors: string[] = [];

  let margin: number;
  const m = Number(form.margin);
  if (form.margin.trim() === '' || !Number.isFinite(m)) {
    errors.push('安全余量必须是有限数');
    margin = NaN;
  } else if (m < 0) {
    errors.push('安全余量必须是非负数');
    margin = m;
  } else {
    margin = m;
  }

  // 件数由导入环节保证（编辑界面不增删件）

  const items = form.items.map((d, i) => {
    const where = `货物 "${d.id || `#${i + 1}`}"`;
    const w = parseNum(d.weight);
    const x = parseNum(d.x);
    const y = parseNum(d.y);
    const hasMin = d.weightMin.trim() !== '';
    const hasMax = d.weightMax.trim() !== '';
    const wmin = hasMin ? parseNum(d.weightMin) : NaN;
    const wmax = hasMax ? parseNum(d.weightMax) : NaN;

    if (!(w > 0)) {
      errors.push(`${where}：重量必须为正数`);
    }
    if (hasMin && !(wmin > 0)) {
      errors.push(`${where}：重量下界必须为正数（留空表示不设下界）`);
    }
    if (hasMax && !(wmax > 0)) {
      errors.push(`${where}：重量上界必须为正数（留空表示不设上界）`);
    }
    // 缺省端沿用标称重量；只在两端都可解析时检查区间序与包含关系
    const lo = hasMin ? wmin : w;
    const hi = hasMax ? wmax : w;
    if ((w > 0) && (hasMin || hasMax)) {
      if (wmin > 0 && wmax > 0 && hasMin && hasMax && wmin > wmax) {
        errors.push(`${where}：重量区间非法（下界 ${wmin} ＞ 上界 ${wmax}）`);
      } else if (lo > 0 && hi > 0 && (w < lo || w > hi)) {
        errors.push(
          `${where}：标称重量 ${w} 必须落在登记区间 [${hasMin ? wmin : w}, ${hasMax ? wmax : w}] 内`,
        );
      }
    }
    if (!(Math.abs(x) <= COORD_BOUND)) {
      errors.push(`${where}：X 必须是绝对值不超过 1e6 的有限数`);
    }
    if (!(Math.abs(y) <= COORD_BOUND)) {
      errors.push(`${where}：Y 必须是绝对值不超过 1e6 的有限数`);
    }

    const item: Workspace['items'][number] = {
      id: d.id,
      weight: w,
      center: { x, y },
    };
    if (hasMin && wmin > 0) item.weightMin = wmin;
    if (hasMax && wmax > 0) item.weightMax = wmax;
    return item;
  });

  if (errors.length > 0) return { ok: false, errors };

  const workspace: Workspace = { polygon, items, margin };
  return { ok: true, result: analyzeStability(workspace) };
}

/**
 * 展示用：最多保留 6 位小数；title 属性另行提供未舍入原值。
 * 极小但非零的数（如 1e-12 的正余量/短缺）改用科学计数法，
 * 绝不舍入成 0——面板上不得出现“实际余量 0 小于要求 0”这类伪结论。
 */
export function fmt(n: number, digits = 6): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const rounded = Number(n.toFixed(digits));
  if (rounded !== 0) return String(rounded);
  // 非零值在 6 位小数下会被抹掉：用科学计数法保留其非零身份（7 位有效数字）
  return n.toExponential(6);
}

/**
 * 成对数值的展示：两个需要直接比较的指标（实际余量 vs 要求余量、富余/短缺等）
 * 若在默认精度下被显示成同一个值，则共同提升精度（必要时科学计数法），
 * 保证“图上/面上的合格”与原始数值判定表达一致。
 */
export function fmtPair(a: number, b: number, digits = 6): [string, string] {
  const sa = fmt(a, digits);
  const sb = fmt(b, digits);
  if (sa !== sb || a === b) return [sa, sb];
  // 默认显示相同但原值不同：逐步加码直到可区分
  for (const d of [9, 12, 15]) {
    const va = fmt(a, d);
    const vb = fmt(b, d);
    if (va !== vb) return [va, vb];
  }
  // 极端情况退回到完整指数精度
  return [a.toExponential(6), b.toExponential(6)];
}
