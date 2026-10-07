import { useState } from 'react';
import { validateRehearsalTarget, rehearseMove } from '../lib/rehearsal';
import { COORD_BOUND } from '../lib/parse';
import type {
  MoveRehearsal,
  Point,
  StabilityResult,
  Workspace,
} from '../lib/types';

interface Props {
  workspace: Workspace;
  /** 当前生效（与俯视图、数值面板同源）的起点稳定性结果 */
  startResult: StabilityResult;
  /** 当前预演；撤销预演 / 非法目标 / 编辑表单后为 null */
  rehearsal: MoveRehearsal | null;
  /** 非法目标导致预演被撤销时的一次性错误信息 */
  errors: string[] | null;
  onRehearse: (r: MoveRehearsal | null) => void;
  onErrors: (errors: string[] | null) => void;
  /** 仅在全程通过（rehearsal-pass）时可调用 */
  onApplyTarget: (itemIndex: number, target: Point) => void;
}

/**
 * 单件货物「移动预演」控制面板。
 *
 * 选择一件货物并输入目标中心后，沿原中心 → 目标中心的完整直线路径，
 * 对标称与允许重量区间的鲁棒稳定性逐点证明（利用距离沿路径的分式线性结构，
 * 不是按少量采样点放行）。预演结果同时驱动俯视图与数值面板。
 *
 * - 全程通过：允许「应用目标位置」；
 * - 途中失守：给出宽度 ≤ 0.0001 的已证安全／已证失守比例边界及可复算见证，
 *   应用入口保持禁用；
 * - 任一点无法裁决：提示暂缓，禁止应用；
 * - 非法目标：撤销预演，不改动原工作区与原放行结论。
 */
export default function MoveRehearsalPanel({
  workspace,
  startResult,
  rehearsal,
  errors,
  onRehearse,
  onErrors,
  onApplyTarget,
}: Props) {
  const [itemIndexText, setItemIndexText] = useState('');
  const [tx, setTx] = useState('');
  const [ty, setTy] = useState('');

  const items = workspace.items;
  const selectedIndex =
    rehearsal !== null
      ? rehearsal.itemIndex
      : Number.isInteger(Number(itemIndexText))
        ? Number(itemIndexText)
        : NaN;

  const run = () => {
    const idx = Number(itemIndexText);
    const target: Point = { x: Number(tx), y: Number(ty) };
    const found =
      Number.isInteger(idx) ? items.findIndex((_, i) => i === idx) : -1;

    // 下标文本本身的可读错误（validateRehearsalTarget 只认 0 基下标）
    const localErrors: string[] = [];
    if (itemIndexText.trim() === '' || found < 0) {
      localErrors.push('移动预演：请输入 0 基货物序号（0 起，见明细表行序）');
    }
    if (tx.trim() === '' || !Number.isFinite(target.x)) {
      localErrors.push('移动预演：目标 X 必须是有限数');
    }
    if (ty.trim() === '' || !Number.isFinite(target.y)) {
      localErrors.push('移动预演：目标 Y 必须是有限数');
    }
    if (found >= 0 && Number.isFinite(target.x) && Number.isFinite(target.y)) {
      localErrors.push(...validateRehearsalTarget(workspace, found, target));
    }

    if (localErrors.length > 0) {
      // 非法目标撤销预演：工作区与原放行结论原样保留
      onErrors(localErrors);
      onRehearse(null);
      return;
    }
    onErrors(null);
    onRehearse(
      rehearseMove({ workspace, itemIndex: found, target, startResult }),
    );
  };

  const cancel = () => {
    onRehearse(null);
    onErrors(null);
  };

  const passed = rehearsal?.status === 'rehearsal-pass';

  return (
    <section className="panel rehearsal-panel" data-testid="rehearsal-panel">
      <div className="panel-head">
        <h2>单件货物移动预演</h2>
        {rehearsal && (
          <div className="row-actions">
            {passed && (
              <button
                type="button"
                className="btn primary"
                data-testid="apply-target-btn"
                onClick={() => onApplyTarget(rehearsal.itemIndex, rehearsal.target)}
              >
                应用目标位置
              </button>
            )}
            <button
              type="button"
              className="btn ghost"
              data-testid="cancel-rehearsal-btn"
              onClick={cancel}
            >
              撤销预演
            </button>
          </div>
        )}
      </div>
      <p className="hint">
        选定一件货物（0 基序号）并输入目标中心，工作台会沿<strong>原中心→目标中心的完整直线路径</strong>
        逐点证明标称与允许重量区间下的鲁棒稳定性（距离沿路径是一次分式线性函数，
        端点/角点根证明，非抽样）。边界恰等于 margin 仍算安全；
        途中失守返回宽度不超过 <code>0.0001</code> 的安全/失守比例边界与可复算见证；
        任一点无法裁决只能<strong>暂缓</strong>。未全程通过不得应用目标位置。
      </p>
      <div className="rehearsal-controls">
        <label>
          货物序号
          <input
            type="number"
            min={0}
            max={Math.max(0, items.length - 1)}
            step={1}
            value={itemIndexText}
            aria-label="移动预演货物序号"
            onChange={(e) => setItemIndexText(e.target.value)}
          />
        </label>
        <label>
          目标 X
          <input
            type="number"
            step="any"
            value={tx}
            aria-label="移动预演目标 X"
            onChange={(e) => setTx(e.target.value)}
          />
        </label>
        <label>
          目标 Y
          <input
            type="number"
            step="any"
            value={ty}
            aria-label="移动预演目标 Y"
            onChange={(e) => setTy(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn primary"
          data-testid="run-rehearsal-btn"
          onClick={run}
        >
          执行移动预演
        </button>
      </div>
      <p className="hint rehearsal-coords">
        坐标绝对值上界 {COORD_BOUND}
        {Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < items.length && (
          <>
            {' '}· 当前选择：{items[selectedIndex].id}（原中心 {items[selectedIndex].center.x},{' '}
            {items[selectedIndex].center.y}）
          </>
        )}
      </p>

      {errors && (
        <div className="banner err" data-testid="rehearsal-errors" role="alert">
          <strong>非法目标，预演已撤销（原工作区与原放行结论未改动）：</strong>
          <ul>
            {errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
