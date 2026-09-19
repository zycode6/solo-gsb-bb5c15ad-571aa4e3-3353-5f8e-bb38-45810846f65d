import type { MergeIssue } from '../lib/merge';

interface ExportPanelProps {
  conflictCount: number;
  resolvedCount: number;
  unresolved: number;
  issues: MergeIssue[];
  autoFix: boolean;
  onAutoFix(v: boolean): void;
  cueCount: number;
  preview: string;
  canExport: boolean;
  onExport(): void;
  onJump(groupIndex: number): void;
}

export function ExportPanel(props: ExportPanelProps) {
  const { unresolved, issues, canExport } = props;
  let disabledReason = '';
  if (props.cueCount === 0) disabledReason = '没有可导出的字幕';
  if (unresolved > 0) disabledReason = `还有 ${unresolved} 个未解决冲突`;
  else if (issues.length > 0) disabledReason = `存在 ${issues.length} 个校验错误`;

  return (
    <aside className="export-panel">
      <h2 className="panel-title">合并与导出</h2>

      <ul className="checklist">
        <li className={unresolved === 0 ? 'pass' : 'fail'}>
          <span className="check-ic">{unresolved === 0 ? '✓' : '!'}</span>
          冲突解决：{props.resolvedCount}/{props.conflictCount}
          {unresolved > 0 && <em>（未处理冲突不得导出）</em>}
        </li>
        <li className={issues.length === 0 ? 'pass' : 'fail'}>
          <span className="check-ic">{issues.length === 0 ? '✓' : '!'}</span>
          时间单调性校验：{issues.length === 0 ? '通过' : `${issues.length} 个错误`}
        </li>
        <li className="pass">
          <span className="check-ic">✓</span>
          输出 {props.cueCount} 条字幕（导出时从 1 重新编号）
        </li>
      </ul>

      <label className="autofix">
        <input
          type="checkbox"
          checked={props.autoFix}
          onChange={(e) => props.onAutoFix(e.target.checked)}
        />
        自动修复时间重叠 / 非单调问题
      </label>

      {issues.length > 0 && (
        <div className="issues">
          {issues.map((it, i) => (
            <button key={i} className="issue" onClick={() => props.onJump(it.groupIndex)}>
              {it.message}
            </button>
          ))}
        </div>
      )}

      <h3 className="panel-sub">结果预览</h3>
      <pre className="preview">{props.preview || '（暂无内容）'}</pre>

      <button
        className="btn primary lg block"
        disabled={!canExport}
        title={canExport ? '下载 merged.srt' : disabledReason}
        onClick={props.onExport}
      >
        {canExport ? '下载合并 SRT' : disabledReason || '暂不可导出'}
      </button>
    </aside>
  );
}
