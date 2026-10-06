import { useState } from 'react';
import { parseWorkspaceJSON } from '../lib/parse';
import { SAMPLE_INPUT } from '../lib/sample';
import type { Workspace } from '../lib/types';

interface Props {
  onApply: (ws: Workspace) => void;
}

/**
 * 导入面板。校验失败（JSON 语法、重复顶点、非凸/退化、非法重量、未知字段等）
 * 整批拒绝：onApply 不会被调用，当前工作区由父组件原样保留。
 */
export default function ImportPanel({ onApply }: Props) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const [okMsg, setOkMsg] = useState(false);

  const doImport = () => {
    const result = parseWorkspaceJSON(text);
    if (result.ok) {
      setErrors(null);
      setOkMsg(true);
      onApply(result.workspace);
    } else {
      // 整批拒绝：不触碰现有工作区
      setErrors(result.errors);
      setOkMsg(false);
    }
  };

  const loadSample = () => {
    setText(SAMPLE_INPUT);
    setErrors(null);
    setOkMsg(false);
  };

  return (
    <section className="panel import-panel">
      <div className="panel-head">
        <h2>导入数据</h2>
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={loadSample}>
            载入示例
          </button>
          <button type="button" className="btn primary" onClick={doImport}>
            导入并建立工作区
          </button>
        </div>
      </div>
      <p className="hint">
        JSON：<code>polygon</code> 为逆时针严格凸多边形顶点（<code>[x,y]</code> 或{' '}
        <code>{'{x,y}'}</code>，绝对值 ≤ 1e6）；<code>items</code> 为 1–200
        件货物，含唯一 <code>id</code>、正数 <code>weight</code>、<code>center</code>，
        并可给可选的正数 <code>weightMin</code> / <code>weightMax</code>
        （省略端沿用标称重量，两者都省略即为旧版确定重量）；<code>margin</code> 为非负数。
        区间必须满足 weightMin ≤ weight ≤ weightMax，任何非法字段、范围或未知字段都会整批拒绝。
      </p>
      <textarea
        className="json-input"
        rows={10}
        spellCheck={false}
        value={text}
        placeholder='{"polygon":[[0,0],[4000,0],[4000,2000],[0,2000]],"items":[{"id":"A","weight":120,"center":[1800,900]}],"margin":150}'
        onChange={(e) => {
          setText(e.target.value);
          setOkMsg(false);
        }}
      />
      {okMsg && <div className="banner ok">导入成功，工作区已替换。</div>}
      {errors && (
        <div className="banner err">
          <strong>整批拒绝，当前工作区未改动：</strong>
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
