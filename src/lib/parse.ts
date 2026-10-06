import { checkStrictConvexCCW } from './geometry';
import type { CargoItem, FormResult, Point, Workspace } from './types';

/** 坐标绝对值上界 */
export const COORD_BOUND = 1e6;
/** 货物件数范围 */
export const MIN_ITEMS = 1;
export const MAX_ITEMS = 200;

const ALLOWED_TOP_KEYS = new Set(['polygon', 'items', 'margin']);
const ALLOWED_POINT_KEYS = new Set(['x', 'y']);
const ALLOWED_ITEM_KEYS = new Set(['id', 'weight', 'weightMin', 'weightMax', 'center']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 收集对象上的未知字段（含 null 原型对象） */
function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 解析并严格校验一个点：坐标为有限数且绝对值不超过 1e6 */
function parsePoint(v: unknown, path: string, errors: string[]): Point | null {
  if (Array.isArray(v)) {
    if (v.length !== 2) {
      errors.push(`${path}：数组点必须恰好包含 2 个坐标`);
      return null;
    }
    const [x, y] = v;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      errors.push(`${path}：坐标必须是有限数`);
      return null;
    }
    if (Math.abs(x) > COORD_BOUND || Math.abs(y) > COORD_BOUND) {
      errors.push(`${path}：坐标绝对值不能超过 1e6`);
      return null;
    }
    return { x, y };
  }

  if (!isPlainObject(v)) {
    errors.push(`${path}：必须是 [x, y] 数组或 {x, y} 对象`);
    return null;
  }

  for (const k of unknownKeys(v, ALLOWED_POINT_KEYS)) {
    errors.push(`${path}：未知字段 "${k}"`);
  }
  const { x, y } = v;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    errors.push(`${path}：x、y 必须是有限数`);
    return null;
  }
  if (Math.abs(x) > COORD_BOUND || Math.abs(y) > COORD_BOUND) {
    errors.push(`${path}：坐标绝对值不能超过 1e6`);
    return null;
  }
  return { x, y };
}

/**
 * 解析整批导入数据。任何错误都返回全部错误信息且不产出工作区，
 * 由调用方保留当前工作区。
 */
export function parseWorkspace(input: unknown): FormResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['导入数据必须是 JSON 对象'] };
  }

  for (const k of unknownKeys(input, ALLOWED_TOP_KEYS)) {
    errors.push(`顶层未知字段 "${k}"`);
  }

  // 支撑多边形
  let polygon: Point[] = [];
  if (!Array.isArray(input.polygon)) {
    errors.push('polygon：必须是按逆时针顺序给出的顶点数组');
  } else {
    for (let i = 0; i < input.polygon.length; i++) {
      const p = parsePoint(input.polygon[i], `polygon[${i}]`, errors);
      if (p) polygon.push(p);
    }
    if (polygon.length === input.polygon.length && polygon.length >= 3) {
      const check = checkStrictConvexCCW(polygon);
      if (!check.valid) {
        errors.push(`polygon：${POLYGON_ERROR_MESSAGES[check.error!]}`);
        polygon = [];
      }
    } else if (polygon.length === input.polygon.length) {
      errors.push('polygon：至少需要 3 个顶点');
      polygon = [];
    }
  }

  // 货物
  let items: CargoItem[] = [];
  if (!Array.isArray(input.items)) {
    errors.push('items：必须是货物数组');
  } else {
    if (input.items.length < MIN_ITEMS || input.items.length > MAX_ITEMS) {
      errors.push(`items：货物数量必须在 ${MIN_ITEMS} 至 ${MAX_ITEMS} 件之间`);
    }

    const seenIds = new Set<string>();
    for (let i = 0; i < input.items.length; i++) {
      const path = `items[${i}]`;
      const raw = input.items[i];
      if (!isPlainObject(raw)) {
        errors.push(`${path}：必须是对象`);
        continue;
      }
      for (const k of unknownKeys(raw, ALLOWED_ITEM_KEYS)) {
        errors.push(`${path}：未知字段 "${k}"`);
      }

      let validId = false;
      const id = raw.id;
      if (typeof id !== 'string' || id.trim() === '') {
        errors.push(`${path}.id：必须是非空字符串且唯一`);
      } else if (seenIds.has(id)) {
        errors.push(`${path}.id：货物 id "${id}" 重复`);
      } else {
        seenIds.add(id);
        validId = true;
      }

      let validWeight = false;
      const weight = raw.weight;
      if (!isFiniteNumber(weight)) {
        errors.push(`${path}.weight：必须是有限数`);
      } else if (weight <= 0) {
        errors.push(`${path}.weight：必须为正数`);
      } else {
        validWeight = true;
      }

      // 可选重量区间：任一边界给出即按区间处理；缺省的一端沿用标称重量。
      // 必须为正数且 weightMin <= weight <= weightMax，否则整批拒绝。
      let validRange = false;
      let weightMin: number | undefined;
      let weightMax: number | undefined;
      {
        const hasMin = Object.prototype.hasOwnProperty.call(raw, 'weightMin');
        const hasMax = Object.prototype.hasOwnProperty.call(raw, 'weightMax');
        const rawMin: unknown = raw.weightMin;
        const rawMax: unknown = raw.weightMax;
        const minOk = isFiniteNumber(rawMin);
        const maxOk = isFiniteNumber(rawMax);
        if (hasMin && (!minOk || rawMin <= 0)) {
          errors.push(`${path}.weightMin：必须为正数（有限数）`);
        }
        if (hasMax && (!maxOk || rawMax <= 0)) {
          errors.push(`${path}.weightMax：必须为正数（有限数）`);
        }

        const w = validWeight ? (weight as number) : NaN;
        // 缺省端沿用确定重量；标称重量非法时已在前面记录错误，这里不组装即可
        if (hasMin && minOk && rawMin > 0) weightMin = rawMin;
        if (hasMax && maxOk && rawMax > 0) weightMax = rawMax;
        if (hasMin && !hasMax && validWeight) weightMax = w;
        if (!hasMin && hasMax && validWeight) weightMin = w;

        if (weightMin !== undefined && weightMax !== undefined) {
          if (weightMin > weightMax) {
            errors.push(
              `${path}：重量区间非法（weightMin ${weightMin} ＞ weightMax ${weightMax}）`,
            );
          } else if (validWeight && (w < weightMin || w > weightMax)) {
            errors.push(
              `${path}：标称重量 ${w} 必须落在登记区间 [${weightMin}, ${weightMax}] 内`,
            );
          } else {
            validRange = true;
          }
        } else if (!hasMin && !hasMax) {
          validRange = true; // 无区间：沿用确定重量（旧 JSON 兼容）
        }
      }

      const center = parsePoint(raw.center, `${path}.center`, errors);

      // 任一错误都会让 errors 非空从而整批拒绝；全部合法时才组装
      if (validId && validWeight && center && validRange) {
        const item: CargoItem = { id: id as string, weight: weight as number, center };
        if (weightMin !== undefined) item.weightMin = weightMin;
        if (weightMax !== undefined) item.weightMax = weightMax;
        items.push(item);
      }
    }
  }

  // 安全余量
  let margin = 0;
  if (input.margin === undefined) {
    margin = 0;
  } else if (!isFiniteNumber(input.margin)) {
    errors.push('margin：必须是有限数');
  } else if (input.margin < 0) {
    errors.push('margin：必须是非负数');
  } else {
    margin = input.margin;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const workspace: Workspace = { polygon, items, margin };
  return { ok: true, workspace };
}

const POLYGON_ERROR_MESSAGES: Record<string, string> = {
  'too-few-points': '支撑多边形至少需要 3 个顶点',
  'duplicate-vertex': '支撑多边形存在重复顶点',
  'degenerate-edge': '支撑多边形存在共线连续顶点或退化边（必须严格凸）',
  'clockwise-or-degenerate': '支撑多边形顶点必须按逆时针顺序给出',
  'non-convex': '支撑多边形不是凸多边形',
  'non-convex-self-intersecting': '支撑多边形自交或非凸（必须为严格凸多边形）',
};

/** 解析 JSON 文本，语法错误同样整批拒绝 */
export function parseWorkspaceJSON(text: string): FormResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [`JSON 语法错误：${e instanceof Error ? e.message : String(e)}`],
    };
  }
  return parseWorkspace(data);
}
