import { useEffect, useState } from 'react';
import type { FormState } from '../lib/form';
import { fmt } from '../lib/form';
import type { MovementPreview, Point } from '../lib/types';

interface Props {
  items: FormState['items'];
  preview: MovementPreview | null;
  previewError: string | null;
  onPreview: (itemId: string, target: Point) => void;
  onClear: () => void;
  onApply: () => void;
}

export const MOVE_BOUNDARY_EPSILON = 0.0001;

export function canApplyMovePreview(
  preview: MovementPreview | null,
  itemId: string,
  xText: string,
  yText: string,
): boolean {
  if (!preview || preview.status !== 'all-safe' || preview.itemId !== itemId) return false;
  const x = xText.trim() === '' ? NaN : Number(xText);
  const y = yText.trim() === '' ? NaN : Number(yText);
  return x === preview.target.x && y === preview.target.y;
}

/**
 * 单件货物移动预演面板。
 * 非法目标只在本面板报错并撤销预演，不修改表单/工作区，也不触碰既有放行结论；
 * 只有同一份 MovementPreview 证明 [0,1] 全程安全时才允许应用目标位置。
 */
export default function MovePanel({
  items,
  preview,
  previewError,
  onPreview,
  onClear,
  onApply,
}: Props) {
  const [itemId, setItemId] = useState(items[0]?.id ?? '');
  const [x, setX] = useState('');
  const [y, setY] = useState('');

  useEffect(() => {
    if (!items.some((it) => it.id === itemId)) setItemId(items[0]?.id ?? '');
  }, [items, itemId]);

  const selected = items.find((it) => it.id === itemId);
  const fillFrom = () => {
    if (selected) {
      setX(selected.x);
      setY(selected.y);
    }
  };

  const submit = () => {
    const tx = x.trim() === '' ? NaN : Number(x);
    const ty = y.trim() === '' ? NaN : Number(y);
    onPreview(itemId, { x: tx, y: ty });
  };

  const canApply = canApplyMovePreview(preview, itemId, x, y);

  return (
    <section className="panel move-panel" data-testid="move-panel">
      <div className="panel-head">
        <h2>单件货物移动预演</h2>
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={fillFrom} disabled={!selected}>
            填入原中心
          </button>
          <button type="button" className="btn ghost" onClick={onClear}>
            撤销预演
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={!itemId}>
            预演直线移动
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="apply-move"
            onClick={onApply}
            disabled={!canApply}
            title={canApply ? '应用已证明全程安全的目标中心' : '只有全程通过的预演才能应用'}
          >
            应用目标位置
          </button>
        </div>
      </div>

      <div className="move-controls">
        <label>
          移动货物
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="移动货物">
            {items.map((it) => (
              <option key={it.id} value={it.id}>{it.id}</option>
            ))}
          </select>
        </label>
        <label>
          目标中心 X
          <input
            type="number"
            step="any"
            value={x}
            aria-label="目标中心 X"
            onChange={(e) => setX(e.target.value)}
          />
        </label>
        <label>
          目标中心 Y
          <input
            type="number"
            step="any"
            value={y}
            aria-label="目标中心 Y"
            onChange={(e) => setY(e.target.value)}
          />
        </label>
      </div>

      <p className="hint">
        从原中心到目标中心检查连续直线路径；证明使用“端点角点最坏距离的凹性”，
        不是离散采样。边界恰等于 margin 仍算安全。预演、俯视图和数值面板使用同一份结果；
        未全程通过时“应用目标位置”保持禁用。
      </p>

      {selected && (
        <p className="hint" data-testid="move-source">
          当前原中心：({selected.x}, {selected.y})
        </p>
      )}

      {previewError && (
        <div className="banner err" role="alert" data-testid="move-error">
          非法目标，已撤销预演；原工作区和原放行结论未改动：
          <ul>{previewError.split('\n').map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}

      {preview && (
        <div
          className={`move-result ${preview.status}`}
          data-testid="move-status"
          data-status={preview.status}
        >
          <strong>
            {preview.status === 'all-safe' && '移动预演全程安全'}
            {preview.status === 'fails-after-start' && '移动途中失守'}
            {preview.status === 'start-fail' && '起点不能放行'}
            {preview.status === 'indeterminate' && '移动预演暂缓'}
          </strong>
          <span>
            货物 {preview.itemId}：({fmt(preview.from.x)}, {fmt(preview.from.y)}) →
            ({fmt(preview.target.x)}, {fmt(preview.target.y)})
          </span>
          {preview.status === 'fails-after-start' && (
            <span data-testid="move-boundary">
              已证安全 t ≤ {fmt(preview.safeRatio!, 7)}；已证失守 t ≥ {fmt(preview.unsafeRatio!, 7)}
              （边界宽度 {fmt(preview.boundaryWidth!, 7)} ≤ 0.0001；边界等于 margin 算安全）。
            </span>
          )}
          {preview.status === 'all-safe' && (
            <span>安全比例 1（0%–100% 连续证明），可以应用目标位置。</span>
          )}
          {preview.reason && <span role="alert">{preview.reason}</span>}
          {preview.witness && (
            <span data-testid="move-witness">
              失守见证 t={fmt(preview.witness.ratio, 7)}：重心
              ({fmt(preview.witness.cog.x)}, {fmt(preview.witness.cog.y)})，
              首先失守边 #{preview.witness.criticalEdge.index}，
              距离 {fmt(preview.witness.criticalEdge.signedDistance)}，
              margin {fmt(preview.targetResult.margin)}。
            </span>
          )}
        </div>
      )}
    </section>
  );
}
