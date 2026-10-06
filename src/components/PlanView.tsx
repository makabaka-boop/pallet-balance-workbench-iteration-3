import type { Point, StabilityResult } from '../lib/types';
import { fmt } from '../lib/form';

const VIEW_W = 820;
const VIEW_H = 620;
const PAD = 70;

interface Props {
  result: StabilityResult;
}

/**
 * 俯视图。所有图元（支撑区、安全余量区、货物、标称重心、鲁棒失败见证、
 * 危险边及余量垂线）均取自同一个 StabilityResult——图与数永远对同一次判断负责。
 *
 * 图上明确区分：
 * - 青色十字：标称登记重量下的合成重心；
 * - 红黄色五边形「失败见证」：某一允许重量组合下失守 margin 的极端重心；
 * 二者同时出现，绝不互相冒充。
 */
export default function PlanView({ result }: Props) {
  const {
    polygon,
    safeRegion,
    edges,
    criticalEdge,
    cog,
    stable,
    releasable,
    warnings,
    margin,
    items,
    robust,
  } = result;
  const marginUnresolvable = warnings.some(
    (w) => w.code === 'margin-below-resolution',
  );
  const witness = robust.status === 'robust-fail' ? robust.witness : null;

  // 统一包围盒：支撑多边形、全部货物、标称重心、失败见证重心
  const points: Point[] = [...polygon, cog];
  if (witness) points.push(witness.cog);
  const maxWeight = Math.max(...items.map((i) => i.weight));
  // safeRegion 为空（余量过大导致塌缩）时不参与包围盒
  if (safeRegion.length >= 3) points.push(...safeRegion);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // 货物中心也纳入包围盒
  for (const it of items) {
    minX = Math.min(minX, it.center.x);
    minY = Math.min(minY, it.center.y);
    maxX = Math.max(maxX, it.center.x);
    maxY = Math.max(maxY, it.center.y);
  }

  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const scale = Math.min((VIEW_W - 2 * PAD) / spanX, (VIEW_H - 2 * PAD) / spanY);

  // 世界坐标 → SVG 坐标（y 轴翻转，居中）
  const usedW = spanX * scale;
  const usedH = spanY * scale;
  const ox = (VIEW_W - usedW) / 2;
  const oy = (VIEW_H - usedH) / 2;
  const sx = (x: number) => ox + (x - minX) * scale;
  const sy = (y: number) => VIEW_H - (oy + (y - minY) * scale);

  const polyPoints = polygon.map((p) => `${fmt(sx(p.x), 3)},${fmt(sy(p.y), 3)}`).join(' ');
  const safePoints = safeRegion
    .map((p) => `${fmt(sx(p.x), 3)},${fmt(sy(p.y), 3)}`)
    .join(' ');

  // 标称重心到标称最危险边的垂足
  const foot = footOf(cog, criticalEdge.a, criticalEdge.b);
  // 失败见证重心到首先失守边的垂足
  const witnessFoot = witness
    ? footOf(witness.cog, witness.criticalEdge.a, witness.criticalEdge.b)
    : null;

  // 放行状态决定图形着色（颜色只由同一份结论驱动）：
  // 可放行=绿；鲁棒失败/标称不稳定=红；其余（暂缓/无法裁决）=琥珀
  const supportStroke = !stable || robust.status === 'robust-fail'
    ? '#dc2626'
    : releasable
      ? '#16a34a'
      : '#d97706';
  const supportFill = !stable || robust.status === 'robust-fail'
    ? 'rgba(239,68,68,0.10)'
    : releasable
      ? 'rgba(34,197,94,0.12)'
      : 'rgba(217,119,6,0.12)';

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="planview"
      role="img"
      aria-label="支撑区、标称重心与鲁棒失败见证俯视图"
    >
      <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="#0f172a" rx={10} />

      {/*
        安全余量内缩区域。
        只有能与原支撑边可靠区分的内缩才会绘制：
        margin=0 时本就没有安全区，也不画，绝不把原边冒充成“内缩安全区”；
        余量低于分辨极限时 safeRegion 为空，并在图面下方显式告警。
      */}
      {margin > 0 && safeRegion.length >= 3 && (
        <polygon
          points={safePoints}
          fill="rgba(59,130,246,0.14)"
          stroke="#3b82f6"
          strokeWidth={1.5}
          strokeDasharray="7 5"
        />
      )}
      {margin > 0 && safeRegion.length < 3 && (
        <g className="safe-missing-note">
          <text x={VIEW_W / 2} y={34} textAnchor="middle" fontSize={14} fill="#fbbf24">
            {marginUnresolvable
              ? `余量 ${margin} 低于当前坐标尺度的图形分辨极限：无可绘制的内缩安全区（见数值面板告警）`
              : 'margin 内缩安全区已塌缩为空'}
          </text>
        </g>
      )}

      {/* 支撑多边形 */}
      <polygon
        points={polyPoints}
        fill={supportFill}
        stroke={supportStroke}
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* 普通边；鲁棒首先失守边以紫红粗边另作标记 */}
      {edges.map((e) => {
        const isCritical = e.index === criticalEdge.index;
        const isWitnessEdge = witness?.criticalEdge.index === e.index;
        return (
          <line
            key={`edge-${e.index}`}
            x1={sx(e.a.x)}
            y1={sy(e.a.y)}
            x2={sx(e.b.x)}
            y2={sy(e.b.y)}
            stroke={isWitnessEdge ? '#fb7185' : isCritical ? '#ef4444' : '#64748b'}
            strokeWidth={isWitnessEdge ? 5.5 : isCritical ? 3 : 1.5}
            strokeDasharray={isWitnessEdge && !isCritical ? '10 4' : undefined}
          />
        );
      })}

      {/* 支撑顶点 */}
      {polygon.map((p, i) => (
        <circle key={`v-${i}`} cx={sx(p.x)} cy={sy(p.y)} r={3.5} fill="#cbd5e1" />
      ))}

      {/* 标称重心到标称危险边的垂线（实际余量） */}
      <line
        x1={sx(cog.x)}
        y1={sy(cog.y)}
        x2={sx(foot.x)}
        y2={sy(foot.y)}
        stroke="#f87171"
        strokeWidth={1.6}
        strokeDasharray="5 4"
      />
      <circle cx={sx(foot.x)} cy={sy(foot.y)} r={3} fill="#f87171" />

      {/* 货物（半径 ∝ √标称重量；有区间的货物用虚线圈标出半径不确定性） */}
      {items.map((it) => {
        const r = 5 + 11 * Math.sqrt(it.weight / maxWeight);
        const hasRange = it.weightMin !== undefined || it.weightMax !== undefined;
        const rMin = it.weightMin !== undefined
          ? 5 + 11 * Math.sqrt(it.weightMin / maxWeight)
          : r;
        const rMax = it.weightMax !== undefined
          ? 5 + 11 * Math.sqrt(it.weightMax / maxWeight)
          : r;
        return (
          <g key={it.id}>
            {hasRange && (
              <circle
                cx={sx(it.center.x)}
                cy={sy(it.center.y)}
                r={rMax}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.55}
              />
            )}
            {hasRange && rMin < rMax - 0.5 && (
              <circle
                cx={sx(it.center.x)}
                cy={sy(it.center.y)}
                r={rMin}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.55}
              />
            )}
            <circle
              cx={sx(it.center.x)}
              cy={sy(it.center.y)}
              r={r}
              fill="rgba(245,158,11,0.35)"
              stroke="#f59e0b"
              strokeWidth={1.5}
            />
            <text
              x={sx(it.center.x)}
              y={sy(it.center.y) - rMax - 3}
              textAnchor="middle"
              fontSize={12}
              fill="#fbbf24"
            >
              {it.id}
            </text>
          </g>
        );
      })}

      {/* 失败见证：极端重量组合下的合成重心 + 到首先失守边的垂线 */}
      {witness && witnessFoot && (
        <g>
          <line
            x1={sx(witness.cog.x)}
            y1={sy(witness.cog.y)}
            x2={sx(witnessFoot.x)}
            y2={sy(witnessFoot.y)}
            stroke="#fb7185"
            strokeWidth={2}
            strokeDasharray="8 4"
          />
          <WitnessMarker x={sx(witness.cog.x)} y={sy(witness.cog.y)} />
          <text
            x={sx(witness.cog.x) + 16}
            y={sy(witness.cog.y) + 5}
            fontSize={13}
            fontWeight={700}
            fill="#fda4af"
          >
            失败见证
          </text>
        </g>
      )}

      {/* 标称合成重心（青色十字）——即便存在失败见证也照常绘制，二者并存可对照 */}
      <g>
        <circle cx={sx(cog.x)} cy={sy(cog.y)} r={9} fill="none" stroke="#22d3ee" strokeWidth={2} />
        <line
          x1={sx(cog.x) - 13}
          y1={sy(cog.y)}
          x2={sx(cog.x) + 13}
          y2={sy(cog.y)}
          stroke="#22d3ee"
          strokeWidth={2.5}
        />
        <line
          x1={sx(cog.x)}
          y1={sy(cog.y) - 13}
          x2={sx(cog.x)}
          y2={sy(cog.y) + 13}
          stroke="#22d3ee"
          strokeWidth={2.5}
        />
        <text
          x={sx(cog.x) + 14}
          y={sy(cog.y) - 12}
          fontSize={14}
          fontWeight={700}
          fill="#67e8f9"
        >
          标称重心
        </text>
      </g>

      {/* 无法可靠表达的量在图面底部同样显式反馈，图与数一致 */}
      {warnings.length > 0 && (
        <g>
          {warnings.slice(0, 2).map((w, i) => (
            <text
              key={w.code}
              x={VIEW_W / 2}
              y={VIEW_H - 40 + i * 18}
              textAnchor="middle"
              fontSize={13}
              fontWeight={600}
              fill="#fbbf24"
            >
              ⚠ {warningShort(w.code)}
            </text>
          ))}
        </g>
      )}
    </svg>
  );
}

/** 点 p 到有向边 a→b 的垂足 */
function footOf(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t =
    ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** 失败见证标记：红黄描边的五边形，与青色十字标称重心明显区分 */
function WitnessMarker({ x, y }: { x: number; y: number }) {
  const r = 11;
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${fmt(x + rr * Math.cos(ang), 2)},${fmt(y + rr * Math.sin(ang), 2)}`);
  }
  return (
    <>
      <polygon points={pts.join(' ')} fill="rgba(244,63,94,0.35)" stroke="#f43f5e" strokeWidth={2.4} />
      <circle cx={x} cy={y} r={2.2} fill="#fecdd3" />
    </>
  );
}

function warningShort(code: string): string {
  switch (code) {
    case 'total-weight-overflow':
      return '标称合计重量溢出缺失：不可作为正常载荷放行';
    case 'robust-corner-overflow':
      return '存在允许重量组合合计溢出：极端载荷不可审核，鲁棒放行不成立';
    case 'robust-indeterminate':
      return '鲁棒裁决无法可靠完成：不得按可放行处理';
    case 'margin-below-resolution':
      return '余量低于图形分辨极限：内缩安全区不绘制（见数值面板）';
    default:
      return '存在无法可靠表达的量，禁止据此放行';
  }
}
