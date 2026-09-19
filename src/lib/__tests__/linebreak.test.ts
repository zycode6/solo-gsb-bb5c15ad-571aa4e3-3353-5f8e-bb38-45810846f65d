import { describe, expect, it } from 'vitest';
import { displayWidth, measureLines, smartBreak } from '../linebreak';

describe('displayWidth', () => {
  it('全角计 2、半角计 1，标签与零宽不计', () => {
    expect(displayWidth('你好')).toBe(4);
    expect(displayWidth('ab1')).toBe(3);
    expect(displayWidth('你a')).toBe(3);
    expect(displayWidth('<i>你好</i>')).toBe(4);
    expect(displayWidth('{\\an8}台词')).toBe(4);
    expect(displayWidth('  abc  ')).toBe(3);
    expect(displayWidth('😀👨‍👩‍👧')).toBe(4);
    expect(displayWidth('，！')).toBe(4);
    expect(displayWidth('ｱ')).toBe(1); // 半角假名
    expect(displayWidth('ア')).toBe(2); // 全角假名
    expect(displayWidth('é')).toBe(1);
  });
});

describe('smartBreak 基本断行', () => {
  it('未超限时保持单行', () => {
    const r = smartBreak('你好世界', { maxWidth: 20, maxLines: 2, lockManual: true });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('你好世界');
    expect(r.lines).toHaveLength(1);
  });

  it('无空白/标点边界时不可断，超限判失败', () => {
    const r = smartBreak('我们曾经一起走过那条长长的河堤', {
      maxWidth: 20,
      maxLines: 2,
      lockManual: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('overflow');
    expect(r.widestRun).toBe(30);
  });

  it('在逗号后断点，所有行不超限', () => {
    const r = smartBreak('雨水顺着脸颊往下流，分不清是雨还是别的什么', {
      maxWidth: 22,
      maxLines: 2,
      lockManual: true,
    });
    expect(r.ok).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].text).toBe('雨水顺着脸颊往下流，');
    expect(r.lines[1].text).toBe('分不清是雨还是别的什么');
    expect(r.lines.every((l) => l.width <= 22)).toBe(true);
  });

  it('空白边界可断，行首空白被裁掉', () => {
    const r = smartBreak('hello world foo bar', {
      maxWidth: 11,
      maxLines: 4,
      lockManual: true,
    });
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.text)).toEqual(['hello world', 'foo bar']);
    expect(r.lines.every((l) => l.width <= 11)).toBe(true);
  });

  it('同行内的词间空白必须保留（不吞空格）', () => {
    const r = smartBreak('hello world', { maxWidth: 20, maxLines: 1, lockManual: true });
    expect(r.ok).toBe(true);
    expect(r.lines[0].text).toBe('hello world');
    expect(r.lines[0].width).toBe(11);
  });

  it('行内连续空白压缩为一个空格', () => {
    const r = smartBreak('hello    world', { maxWidth: 20, maxLines: 1, lockManual: true });
    expect(r.ok).toBe(true);
    expect(r.lines[0].text).toBe('hello world');
  });

  it('HTML / ASS 标签保留但不计宽', () => {
    const r = smartBreak('{\\an8}<i>雨水顺着脸颊往下流</i>，分不清', {
      maxWidth: 22,
      maxLines: 2,
      lockManual: true,
    });
    expect(r.ok).toBe(true);
    expect(r.lines[0].text).toContain('{\\an8}<i>');
    expect(r.text).toContain('</i>');
    for (const l of r.lines) expect(l.width).toBeLessThanOrEqual(22);
  });
});

describe('smartBreak 手工换行锁定', () => {
  it('锁定时手工换行不可跨越', () => {
    const input = '短行\n这一行非常非常非常长没有标点无法断开啊啊啊啊啊啊';
    const r = smartBreak(input, { maxWidth: 10, maxLines: 2, lockManual: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('overflow');
    expect(r.lines[0].text).toBe('短行');
  });

  it('锁定时最少行数为物理行数；maxLines 不足报 too-many-lines', () => {
    const r = smartBreak('第一行\n第二行\n第三行', { maxWidth: 20, maxLines: 2, lockManual: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-many-lines');
    expect(r.minLines).toBe(3);
  });

  it('解锁时手工换行降级为空白，可跨行合并', () => {
    const locked = smartBreak('你好，\n世界。', { maxWidth: 20, maxLines: 2, lockManual: true });
    expect(locked.lines.map((l) => l.text)).toEqual(['你好，', '世界。']);
    const free = smartBreak('你好，\n世界。', { maxWidth: 20, maxLines: 1, lockManual: false });
    expect(free.ok).toBe(true);
    expect(free.text).toBe('你好， 世界。');
    expect(free.lines).toHaveLength(1);
  });
});

describe('smartBreak 失败原因', () => {
  it('不可断片段超宽 → overflow 且标明超宽量', () => {
    const r = smartBreak('一二三四五六七八九十一二三四五六七八九十', {
      maxWidth: 10,
      maxLines: 5,
      lockManual: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('overflow');
    expect(r.widestRun).toBe(40);
    expect(r.unavoidableOverflow).toBe(30);
  });

  it('即使有断点但行数不够 → too-many-lines', () => {
    // 每个“字，”片段宽 4 ≤ 上限（无超宽），但贪心最少需要 5 行
    const r = smartBreak('一，二，三，四，五', { maxWidth: 4, maxLines: 2, lockManual: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-many-lines');
    expect(r.minLines).toBe(5);
  });
});

describe('smartBreak 优化目标', () => {
  it('常规情形：优先在逗号后断点', () => {
    const r = smartBreak('你好世界，再见。', { maxWidth: 12, maxLines: 2, lockManual: true });
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.text)).toEqual(['你好世界，', '再见。']);
  });

  it('禁则罚分：两种断法行宽分布相同时，避开行尾开括号', () => {
    // 断点 i=2（开括号前）→ [甲甲][（乙乙]；断点 i=3（开括号后）→ [甲甲（][乙乙]。
    // 行宽分别为 4/6 与 6/4，超限与行宽差完全相同，后者行尾为“（”受罚。
    const r = smartBreak('甲甲（乙乙', { maxWidth: 6, maxLines: 2, lockManual: true });
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.text)).toEqual(['甲甲', '（乙乙']);
    for (const l of r.lines) expect(l.text.endsWith('（')).toBe(false);
  });

  it('多段时按全局行宽均匀分配行数', () => {
    const r = smartBreak('甲乙，丙丁\n戊己，庚辛', { maxWidth: 6, maxLines: 4, lockManual: true });
    expect(r.ok).toBe(true);
    expect(r.lines.filter((l) => l.text.length > 0)).toHaveLength(4);
    expect(r.text.split('\n')).toHaveLength(4);
  });

  it('半角禁则变体同样生效', () => {
    const r = smartBreak('ab(cd', { maxWidth: 3, maxLines: 2, lockManual: true });
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.text)).toEqual(['ab', '(cd']);
  });
});

describe('measureLines', () => {
  it('按已有换行逐行量宽', () => {
    const ls = measureLines('你好\nab');
    expect(ls.map((l) => l.width)).toEqual([4, 2]);
    expect(ls.map((l) => l.text)).toEqual(['你好', 'ab']);
  });
});
