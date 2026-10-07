import { describe, expect, it } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanView from './PlanView';
import ResultPanel from './ResultPanel';
import MoveRehearsalPanel from './MoveRehearsalPanel';
import { rehearseMove } from '../lib/rehearsal';
import { applyTargetToForm, resolveForm, workspaceToForm } from '../lib/form';
import type { FormState } from '../lib/form';
import type { MoveRehearsal, Point as WsPoint, Workspace } from '../lib/types';

const square: WsPoint[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

type State = { form: FormState; rehearsal: MoveRehearsal | null; errors: string[] | null };
type Action =
  | { kind: 'rehearse'; index: number; target: WsPoint }
  | { kind: 'cancel' }
  | { kind: 'invalid' }
  | { kind: 'apply' };

/**
 * 与 App 同构的最小页面状态机：编辑即作废预演、
 * 仅 rehearsal-pass 才应用目标、非法目标只作废预演不动表单。
 * 页面测试先把动作序列经纯 reducer 折叠为最终状态，再渲染同一组三个组件，
 * 核对预演与应用状态。
 */
function reduceState(workspace: Workspace, s0: State, a: Action): State {
  const s = s0;
  if (a.kind === 'rehearse') {
    const resolved = resolveForm(workspace.polygon, s.form);
    if (!resolved.ok) return s;
    return {
      ...s,
      rehearsal: rehearseMove({
        workspace: { ...workspace, items: resolved.result.items },
        itemIndex: a.index,
        target: a.target,
        startResult: resolved.result,
      }),
      errors: null,
    };
  }
  if (a.kind === 'cancel' || a.kind === 'invalid') {
    return { ...s, rehearsal: null, errors: a.kind === 'invalid' ? ['非法目标'] : null };
  }
  // apply：与 App 一致，仅在全程通过时允许
  if (a.kind === 'apply' && s.rehearsal?.status === 'rehearsal-pass') {
    return {
      form: applyTargetToForm(s.form, s.rehearsal.itemIndex, s.rehearsal.target),
      rehearsal: null,
      errors: null,
    };
  }
  return s;
}

function View({
  workspace,
  state,
}: {
  workspace: Workspace;
  state: State;
}): ReactNode {
  const resolved = resolveForm(workspace.polygon, state.form);
  if (!resolved.ok) {
    return createElement('div', { 'data-testid': 'no-conclusion' }, '无结论');
  }
  const result = resolved.result;

  return createElement(
    'div',
    null,
    createElement(MoveRehearsalPanel, {
      workspace,
      startResult: result,
      rehearsal: state.rehearsal,
      errors: state.errors,
      onRehearse: () => {},
      onErrors: () => {},
      onApplyTarget: () => {},
    }),
    createElement(PlanView, { result, rehearsal: state.rehearsal }),
    createElement(ResultPanel, { result, rehearsal: state.rehearsal }),
  );
}

function render(workspace: Workspace, actions: Action[]): string {
  const initial: State = {
    form: workspaceToForm(workspace),
    rehearsal: null,
    errors: null,
  };
  const state = actions.reduce((s, a) => reduceState(workspace, s, a), initial);
  return renderToStaticMarkup(createElement(View, { workspace, state }));
}

describe('页面：移动预演与应用状态（预演、俯视图、数值面板同一结果）', () => {
  it('全程通过：面板与 SVG 显示通过态，提供应用按钮；应用后目标落位且无预演残留', () => {
    const workspace: Workspace = {
      polygon: square,
      margin: 5,
      items: [
        { id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 40, y: 50 } },
        { id: 'B', weight: 10, weightMin: 8, weightMax: 12, center: { x: 60, y: 50 } },
      ],
    };

    // 应用前：预演全程通过、提供应用按钮、俯视图画出整条安全路径
    const beforeHtml = render(workspace, [
      { kind: 'rehearse', index: 1, target: { x: 65, y: 50 } },
    ]);
    expect(beforeHtml).toContain('移动预演全程通过');
    expect(beforeHtml).toContain('data-testid="apply-target-btn"');
    expect(beforeHtml).toContain('rehearsal-overlay');

    // 应用后：目标落位（B 的中心变为 65），预演已结束、无叠加层残留
    const initial: State = {
      form: workspaceToForm(workspace),
      rehearsal: null,
      errors: null,
    };
    const applied = [
      { kind: 'rehearse' as const, index: 1, target: { x: 65, y: 50 } },
      { kind: 'apply' as const },
    ].reduce((s, a) => reduceState(workspace, s, a), initial);
    expect(applied.rehearsal).toBeNull();
    expect(applied.form.items[1].x).toBe('65');
    expect(applied.form.items[1].y).toBe('50');

    const afterHtml = renderToStaticMarkup(
      createElement(View, { workspace, state: applied }),
    );
    expect(afterHtml).not.toContain('rehearsal-overlay');
    expect(afterHtml).not.toContain('移动预演途中失守');
    // 应用后仍是同一可放行结论
    expect(afterHtml).toContain('STABLE');
  });

  it('途中失守：显示安全/失守边界与可复算见证，不提供应用按钮，SVG 画出路径与失守点', () => {
    const workspace: Workspace = {
      polygon: square,
      margin: 5,
      items: [
        { id: 'A', weight: 10, weightMin: 10, weightMax: 10, center: { x: 50, y: 50 } },
        { id: 'B', weight: 10, weightMin: 1, weightMax: 200, center: { x: 50, y: 50 } },
      ],
    };
    const html = render(workspace, [
      { kind: 'rehearse', index: 1, target: { x: 98, y: 50 } },
    ]);

    expect(html).toContain('移动预演途中失守');
    expect(html).toContain('目标位置不得应用');
    expect(html).toContain('rehearsal-fail');
    expect(html).toContain('rehearsal-witness');
    // 失守比例 0.984375、首先失守边 #1、极端重量端点 200
    expect(html).toContain('0.984375');
    expect(html).toContain('#1');
    expect(html).toContain('>200<');
    // 俯视图同源：路径叠加层与失守点
    expect(html).toContain('rehearsal-overlay');
    expect(html).toContain('路径失守');
    // 未通过 → 应用按钮不存在
    expect(html).not.toContain('data-testid="apply-target-btn"');
  });

  it('无法裁决：显示暂缓且无应用按钮、无失守见证', () => {
    const workspace: Workspace = {
      polygon: square,
      margin: 1,
      items: [
        { id: 'A', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 40, y: 50 } },
        { id: 'B', weight: 1.7e308, weightMin: 1, weightMax: 1.7e308, center: { x: 60, y: 50 } },
      ],
    };
    const html = render(workspace, [
      { kind: 'rehearse', index: 1, target: { x: 65, y: 50 } },
    ]);
    expect(html).toContain('移动预演暂缓');
    expect(html).toContain('rehearsal-indeterminate');
    expect(html).not.toContain('data-testid="apply-target-btn"');
    expect(html).not.toContain('rehearsal-witness');
  });

  it('撤销预演：错误提示出现但俯视图/面板恢复为无预演的原结论，原工作区不变', () => {
    const workspace: Workspace = {
      polygon: square,
      margin: 5,
      items: [
        { id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 40, y: 50 } },
      ],
    };
    // 即便先前有一个失守预演，非法目标也只作废预演，不动表单
    const initial: State = {
      form: workspaceToForm(workspace),
      rehearsal: null,
      errors: null,
    };
    const state = [
      { kind: 'rehearse' as const, index: 0, target: { x: 95, y: 50 } },
      { kind: 'invalid' as const },
    ].reduce((s, a) => reduceState(workspace, s, a), initial);
    // 预演被撤销、表单仍是原中心 40
    expect(state.rehearsal).toBeNull();
    expect(state.form.items[0].x).toBe('40');

    const html = renderToStaticMarkup(createElement(View, { workspace, state }));
    expect(html).toContain('非法目标');
    expect(html).toContain('预演已撤销');
    // 无预演叠加层、无预演结论，原 STABLE 结论仍在
    expect(html).not.toContain('rehearsal-overlay');
    expect(html).not.toContain('移动预演全程通过');
    expect(html).toContain('STABLE');
  });

  it('预演面板在无预演时提供执行入口且不显示撤销/应用按钮', () => {
    const workspace: Workspace = {
      polygon: square,
      margin: 5,
      items: [{ id: 'A', weight: 10, weightMin: 8, weightMax: 12, center: { x: 50, y: 50 } }],
    };
    const html = render(workspace, []);
    expect(html).toContain('data-testid="run-rehearsal-btn"');
    expect(html).not.toContain('data-testid="apply-target-btn"');
    expect(html).not.toContain('data-testid="cancel-rehearsal-btn"');
    expect(html).not.toContain('rehearsal-overlay');
  });
});
