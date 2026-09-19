import { useMemo, useState } from 'react';
import type { AlignGroup } from '../lib/align';
import { isBrokenStale, resolveGroupText, spanOf } from '../lib/merge';
import type { GroupState } from '../lib/merge';
import { measureLines, smartBreak, type BreakResult, type FailReason } from '../lib/linebreak';
import { formatTimecode, type Cue } from '../lib/srt';

type RowFilter = 'all' | 'ok' | 'fail' | 'applied';

export interface BreakUpdate {
  gi: number;
  /** 断行后的输出文本 */
  text: string;
  /** 应用时的原始文本（用于失效检测） */
  source: string;
}

interface LineBreakPanelProps {
  groups: AlignGroup[];
  states: GroupState[];
  cuesA: Cue[];
  cuesB: Cue[];
  /** 存在于合并结果中的组（丢弃的单边组为 false） */
  kept: boolean[];
  onApply(updates: BreakUpdate[]): void;
  onRestore(indices: number[]): void;
}

const DEFAULT_WIDTH = 28;
const DEFAULT_LINES = 2;

function failText(reason: FailReason | undefined, r: BreakResult): string {
  if (reason === 'overflow') {
    return `存在宽 ${r.widestRun} 的不可断片段（超出上限 ${r.unavoidableOverflow}），请放宽宽度、增加可断标点或手工换行`;
  }
  return `最少需要 ${r.minLines} 行，超过“最多行数”限制，请放宽行数限制或手工调整`;
}

export function LineBreakPanel({ groups, states, cuesA, cuesB, kept, onApply, onRestore }: LineBreakPanelProps) {
  const [maxWidth, setMaxWidth] = useState(DEFAULT_WIDTH);
  const [maxLines, setMaxLines] = useState(DEFAULT_LINES);
  const [lockManual, setLockManual] = useState(true);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [visible, setVisible] = useState(60);

  /** 每组当前设置下的试算结果与失效标记。 */
  const previews = useMemo(() => {
    const map = new Map<
      number,
      { source: string; result: BreakResult; stale: boolean; applied: boolean }
    >();
    groups.forEach((g, gi) => {
      if (!kept[gi]) return;
      const source = resolveGroupText(g, states[gi].resolution, cuesA, cuesB).trim();
      if (!source) return;
      map.set(gi, {
        source,
        result: smartBreak(source, { maxWidth, maxLines, lockManual }),
        stale: isBrokenStale(g, states[gi], cuesA, cuesB),
        applied: states[gi].brokenText !== undefined,
      });
    });
    return map;
  }, [groups, states, cuesA, cuesB, kept, maxWidth, maxLines, lockManual]);

  const countOf = (f: RowFilter) => {
    if (f === 'all') return previews.size;
    let n = 0;
    previews.forEach((p) => {
      if (f === 'ok' && p.result.ok) n++;
      else if (f === 'fail' && !p.result.ok) n++;
      else if (f === 'applied' && p.applied) n++;
    });
    return n;
  };

  const rows = useMemo(() => {
    const out: number[] = [];
    previews.forEach((p, gi) => {
      if (
        filter === 'all' ||
        (filter === 'ok' && p.result.ok) ||
        (filter === 'fail' && !p.result.ok) ||
        (filter === 'applied' && p.applied)
      ) {
        out.push(gi);
      }
    });
    return out;
  }, [previews, filter]);

  const applyRows = (idxs: number[]) => {
    const updates: BreakUpdate[] = [];
    for (const gi of idxs) {
      const p = previews.get(gi);
      if (p && p.result.ok) updates.push({ gi, text: p.result.text, source: p.source });
    }
    if (updates.length > 0) onApply(updates);
  };

  const okRows = rows.filter((gi) => previews.get(gi)!.result.ok);
  const appliedRows = states
    .map((s, i) => (s.brokenText !== undefined ? i : -1))
    .filter((i) => i >= 0 && kept[i]);
  const failCount = countOf('fail');

  const FILTERS: { key: RowFilter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'ok', label: '可应用' },
    { key: 'fail', label: '不满足限制' },
    { key: 'applied', label: '已应用' },
  ];

  return (
    <section className="lb-panel">
      <header className="lb-head">
        <h2 className="panel-title">智能断行</h2>
        <p className="lb-sub">
          在空白 / 标点边界用动态规划选点 · 宽度按 Unicode 字素簇计（全角 2、半角 1，HTML/ASS
          标签不计）· 已应用 {appliedRows.length} 条
          {failCount > 0 && <em className="lb-fail-n"> · {failCount} 条不满足限制</em>}
        </p>
      </header>

      <div className="lb-settings">
        <label className="lb-field">
          <span>每行最大宽度</span>
          <input
            type="number"
            min={1}
            max={200}
            value={maxWidth}
            onChange={(e) => setMaxWidth(Math.max(1, Number(e.target.value) || DEFAULT_WIDTH))}
          />
        </label>
        <label className="lb-field">
          <span>最多行数</span>
          <input
            type="number"
            min={1}
            max={20}
            value={maxLines}
            onChange={(e) => setMaxLines(Math.max(1, Number(e.target.value) || DEFAULT_LINES))}
          />
        </label>
        <label className="lb-check">
          <input type="checkbox" checked={lockManual} onChange={(e) => setLockManual(e.target.checked)} />
          锁定已有手工换行（不可跨越）
        </label>
        <span className="spacer" />
        <button
          className="btn sm primary"
          disabled={okRows.length === 0}
          onClick={() => applyRows(okRows)}
          title="对当前筛选下所有满足限制的条目应用断行"
        >
          批量应用{okRows.length > 0 ? `（${okRows.length}）` : ''}
        </button>
        <button className="btn sm" disabled={appliedRows.length === 0} onClick={() => onRestore(appliedRows)}>
          全部恢复（{appliedRows.length}）
        </button>
      </div>

      <div className="lb-tabs">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`tab ${filter === f.key ? 'active' : ''}`}
            onClick={() => {
              setFilter(f.key);
              setVisible(60);
            }}
          >
            {f.label}
            <span className="tab-count">{countOf(f.key)}</span>
          </button>
        ))}
      </div>

      <div className="lb-list">
        {rows.slice(0, visible).map((gi) => (
          <BreakRow
            key={groups[gi].id}
            gi={gi}
            group={groups[gi]}
            state={states[gi]}
            source={previews.get(gi)!.source}
            result={previews.get(gi)!.result}
            stale={previews.get(gi)!.stale}
            maxWidth={maxWidth}
            maxLines={maxLines}
            cuesA={cuesA}
            cuesB={cuesB}
            onApply={() => applyRows([gi])}
            onRestore={() => onRestore([gi])}
          />
        ))}
        {rows.length === 0 && <div className="empty">当前筛选下没有条目。</div>}
        {rows.length > visible && (
          <button className="btn more" onClick={() => setVisible((v) => v + 60)}>
            显示更多（剩余 {rows.length - visible} 条）
          </button>
        )}
      </div>
    </section>
  );
}

function BreakRow({
  gi,
  group,
  state,
  source,
  result,
  stale,
  maxWidth,
  maxLines,
  cuesA,
  cuesB,
  onApply,
  onRestore,
}: {
  gi: number;
  group: AlignGroup;
  state: GroupState;
  source: string;
  result: BreakResult;
  stale: boolean;
  maxWidth: number;
  maxLines: number;
  cuesA: Cue[];
  cuesB: Cue[];
  onApply(): void;
  onRestore(): void;
}) {
  const applied = state.brokenText !== undefined;
  const effective = applied && !stale;
  // 已应用且未失效、且设置未变时，右侧直接展示导出文本；否则展示当前试算预览
  const appliedLines = applied ? measureLines(state.brokenText ?? source) : null;
  const showApplied = effective && appliedLines !== null;
  const shown = showApplied ? appliedLines! : result.lines;
  const widest = shown.reduce((m, l) => Math.max(m, l.width), 0);

  const span = spanOf(cuesA, group.aIdx) ?? spanOf(cuesB, group.bIdx);

  return (
    <article
      className={`lb-row ${result.ok ? '' : 'lb-bad'} ${effective ? 'lb-applied' : ''} ${
        stale ? 'lb-stale' : ''
      }`}
    >
      <header className="lb-row-head">
        <span className="g-idx">#{gi + 1}</span>
        {span && (
          <span className="lb-time">
            {formatTimecode(span[0])} → {formatTimecode(span[1])}
          </span>
        )}
        <span className="lb-meta">
          {shown.length} 行 · 最宽 {widest}/{maxWidth}
        </span>
        <span className="spacer" />
        {stale && (
          <span className="tag lb-stale-tag" title="源文本已改变，原断行结果已停用，重新应用后生效">
            源已变更·待重应用
          </span>
        )}
        {!result.ok && (
          <span className="tag lb-reason" title={failText(result.reason, result)}>
            {result.reason === 'overflow' ? '不可断超宽' : '行数超限'}
          </span>
        )}
        {effective && <span className="tag ok">✓ 已应用</span>}
        {result.ok ? (
          <button className="btn-mini" onClick={onApply}>
            {applied ? '重新应用' : '应用'}
          </button>
        ) : (
          <button className="btn-mini lb-off" disabled title={failText(result.reason, result)}>
            无法应用
          </button>
        )}
        {applied && (
          <button className="btn-mini lb-restore" onClick={onRestore}>
            恢复
          </button>
        )}
      </header>
      {!result.ok && <div className="lb-msg">{failText(result.reason, result)}</div>}
      {stale && (
        <div className="lb-msg lb-msg-warn">该条源文本在应用后被修改，导出暂用原文；点击“重新应用”可更新。</div>
      )}
      <div className="lb-compare">
        <div className="lb-side">
          <div className="lb-side-title">原文（当前合并结果）</div>
          {source.split('\n').map((l, i) => (
            <div className="lb-line" key={i}>
              <span className="lb-line-text">{l || ' '}</span>
            </div>
          ))}
        </div>
        <div className="lb-arrow">→</div>
        <div className="lb-side">
          <div className="lb-side-title">
            {showApplied ? '断行结果（当前导出文本）' : '断行预览（未应用）'}
          </div>
          {shown.map((l, i) => (
            <div
              className={`lb-line ${l.width > maxWidth ? 'over' : ''} ${i >= maxLines ? 'extraline' : ''}`}
              key={i}
            >
              <span className="lb-line-text">{l.text || ' '}</span>
              <span className="lb-w">{l.width}</span>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
