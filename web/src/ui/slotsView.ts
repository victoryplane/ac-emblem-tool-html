/**
 * 【下】8 个槽位 —— 缩略图 / 槽号 / 占用或"＋新建" / 18 段校验状态（SPEC.md §四）。
 *
 * ★ 这里画的**只是当前所选作品的 8 个槽**（过滤逻辑在 `logic/slots.ts`）。
 *   切作品时 `main.ts` 会重建模型并重画，所以"换作品 ⇒ 换一套槽"。
 *
 * 槽位的语义全在 `logic/slots.ts`（纯逻辑、可测）；这里只负责画。
 * 缩略图放大用 `image-rendering: pixelated`（SPEC.md 要求），因为徽章只有 128×128。
 *
 * ★ 0.20：删掉槽位卡右上角那句 `icon.sys@0xDF`（8 格上重复 8 遍、用户看不懂 ⇒「直接删掉」）。
 *   事实没变：见 `logic/slots.ts` 注释与 `docs\01-项目理解\04-记忆卡与存档处理.md` §六。
 */

import { t } from './logic/i18n.ts';
import { slotSummaryText, type SlotModel } from './logic/slots.ts';
import { dirNameFor, type GameContext, type GameEntry } from './logic/games.ts';
import { state, type SlotThumb } from './state.ts';
import { clear, el } from './dom.ts';

export interface SlotCallbacks {
  onSelect(index: number): void;
}

/**
 * 缩略图节点（**建的时候就把像素画好**）。
 *
 * ★ 0.19：原来先建空 canvas、等插进文档之后再跑一趟 `paintThumbs(querySelectorAll)`
 *   才 `putImageData`（配一个 `WeakMap` 记缩略图 + `dataset.rendered` 标记）。那套机制
 *   只为"延迟一次绘制"，而 `putImageData` 在游离 canvas 上本来就可用 ⇒ 直接画，少 ~15 行
 *   与两个失效标记（`dataset.rendered === '1'` 在"每次都新建 canvas"的前提下永远不成立）。
 */
function thumbNode(thumb: SlotThumb | null, size = 96): HTMLCanvasElement | HTMLDivElement {
  if (!thumb) return el('div', { class: 'thumb-empty', text: t('＋', '+') });
  const cv = el('canvas', { class: 'thumb-cv', width: 128, height: 128 });
  cv.style.width = `${size}px`;
  cv.style.height = `${size}px`;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(new ImageData(thumb.data, thumb.width, thumb.height), 0, 0);
  return cv;
}

/** 某槽的计划存档目录名（空槽用）。 */
function plannedDirName(ctx: GameContext | null, index: number): string | null {
  if (!ctx) return null;
  try {
    return dirNameFor(ctx, index);
  } catch {
    return null;
  }
}

/**
 * 空槽要显示成什么样。
 *
 * ★ 2026-10-04 修的那个 bug 的另一面：过滤之后可能会出现"这个槽属于本作品，
 *   但卡上还没有那个目录"。此时**不能**写"＋新建"（会让人以为点一下就能建），
 *   而要写清"先在游戏里存一个徽章"。
 */
function emptySlotHint(ctx: GameContext | null, index: number, dirExists: boolean): string {
  if (!ctx) return t('＋新建（先选作品）', '+ New (pick a game first)');
  const dir = plannedDirName(ctx, index) ?? t('（目录名算不出来）', "(can't work out the folder name)");
  if (!dirExists) {
    return t(`＋新建（卡上还没有 ${dir}）`, `+ New (the card has no ${dir} yet)`);
  }
  if (ctx.entry.form === 'lr-archive') return t(`＋新建 ${dir}\\data${index}`, `+ New ${dir}\\data${index}`);
  return t(`＋新建 ${dir}`, `+ New ${dir}`);
}

export function renderSlots(model: SlotModel | null, ctx: GameContext | null, cb: SlotCallbacks): void {
  const host = document.getElementById('slot-grid');
  if (!host) return;
  clear(host);

  const host2 = document.getElementById('slot-summary');
  if (host2) {
    clear(host2);
    const text = model ? slotSummaryText(model) : t('还没有打开记忆卡', 'No memory card loaded yet');
    host2.appendChild(el('span', { text }));
    if (model && model.dirNames.length === 0 && model.excludedDirNames.length > 0) {
      host2.appendChild(
        el('span', {
          class: 'warn',
          text: t(
            `　⚠ 这个作品在卡上还没有目录；被隐藏的目录见上面那行（切作品查看）`,
            '  ⚠ This game has no folder on the card yet; the hidden folders are on the line above (switch game to see them)',
          ),
        }),
      );
    }
  }

  for (let i = 0; i < 8; i++) {
    const slot = model?.slots[i] ?? null;
    const thumb = state.thumbs[i] ?? null;
    const selected = state.selectedSlot === i;
    const occupied = !!slot?.occupied;
    const dirName = slot && slot.dirName ? slot.dirName : plannedDirName(ctx, i);
    const dirExists = !!model && !!dirName && model.dirNames.some((d) => d.toUpperCase() === dirName.toUpperCase());
    const cls = ['slot', selected ? 'slot-selected' : '', occupied ? 'slot-occupied' : 'slot-empty']
      .filter(Boolean)
      .join(' ');

    const checkLine = (() => {
      if (!occupied) {
        return el('div', {
          class: dirExists || !ctx ? 'slot-check dim' : 'slot-check warn',
          text: emptySlotHint(ctx, i, dirExists || !ctx),
        });
      }
      if (!thumb) return el('div', { class: 'slot-check bad', text: t('读不出缩略图', 'Cannot read thumbnail') });
      return el('div', {
        class: `slot-check ${thumb.checksumsOk18 ? 'ok' : 'bad'}`,
        text: thumb.checksumsOk18
          ? t('18 段校验 18/18 ✅', '18/18 checksums OK ✅')
          : t(`校验不过：${thumb.checksumDetail}`, `Checksum failed: ${thumb.checksumDetail}`),
      });
    })();

    const card = el(
      'div',
      {
        class: cls,
        'data-slot': String(i),
        role: 'button',
        tabindex: '0',
        onclick: () => cb.onSelect(i),
        onkeydown: (ev: Event) => {
          const k = (ev as KeyboardEvent).key;
          // ★ 0.19（D14）：空格要 `preventDefault()`，否则"用空格选槽"会顺带把页面滚一段。
          if (k === 'Enter' || k === ' ') {
            ev.preventDefault();
            cb.onSelect(i);
          }
        },
      },
      el('span', { class: 'slot-no', text: t(`槽 ${i + 1}`, `Slot ${i + 1}`) }),
      thumbNode(thumb),
      el('div', {
        class: 'slot-name',
        text: occupied && slot?.fileName
          ? `${slot.dirName}\\${slot.fileName}`
          : dirExists || !ctx
            ? t('空 · 可新建', 'Empty · can create')
            : t('空 · 卡上还没有这个目录', 'Empty · this folder is not on the card yet'),
      }),
      occupied && slot
        ? el('div', {
            class: 'slot-meta dim',
            text: t(`${slot.length} B · 首簇 ${slot.cluster}`, `${slot.length} B · first cluster ${slot.cluster}`),
          })
        : null,
      checkLine,
    );
    host.appendChild(card);
  }
}

/** 作品下拉框（只在学校验一次）。 */
export function fillGameSelect(games: readonly GameEntry[], currentId: string): void {
  const sel = document.getElementById('game-select') as HTMLSelectElement | null;
  if (!sel) return;
  clear(sel);
  for (const g of games) {
    const label = t(g.label, g.en) + (g.verified ? ' ✅' : t(' ⚠ 未验证', ' ⚠ unverified'));
    // ★ 0.19（B9）：只写 `.value` —— 原来还额外给 option 加 `selected:` 属性（同一件事写两遍，
    //   而 option 不存在时 `.value =` 是**静默无效**的，两处不一致反而更难查）。
    sel.appendChild(el('option', { value: g.id }, label));
  }
  sel.value = currentId;
}

/** 作品说明 + 自定义序列号输入框的显隐。 */
export function renderGameNote(entry: GameEntry | null): void {
  const note = document.getElementById('game-note');
  if (note) {
    clear(note);
    // ★ 2026-10-05（0.9 / 0.10）：已验证的作品**不再显示**那行"✅ 有实机证据　<说明>"
    //   （用户："这两段也删了"）；只保留**未验证作品的警告** —— 那是安全标注，不能省
    //   （SPEC §七：AC2 / AC2AA / AC3 / NB / 自定义 都要标"未验证"）。
    //   未验证作品的 note 文案本身就以"⚠ 未验证"开头（见 `logic/games.ts`），直接原样显示。
    if (entry && !entry.verified) {
      note.appendChild(el('span', { class: 'warn', text: t(entry.note, entry.noteEn) }));
    }
  }
  const customRow = document.getElementById('custom-serial-row');
  if (customRow) customRow.style.display = entry && entry.id === 'custom' ? '' : 'none';
}

/**
 * 忙提示（`#busy` 那个转圈）。
 *
 * ★ 0.19（B6）：状态行**文本**已经由 `state.ts::setStatus()` 一并写好（收口到一处），
 *   所以这里只剩"忙不忙"这一件事 —— 以前要靠调用方"记得再配一次 renderStatus()"，
 *   9 处里有 2 处忘了配（状态行永远停在上一条文字）。本函数是幂等的兜底。
 */
export function renderStatus(): void {
  const s = document.getElementById('status');
  if (s) s.textContent = state.status;
  const busy = document.getElementById('busy');
  if (busy) busy.style.display = state.busy ? '' : 'none';
}

/** 写入日志（右下角那个滚动框）。 */
export function renderLog(lines: readonly string[]): void {
  const host = document.getElementById('write-log');
  if (!host) return;
  clear(host);
  // ★ 0.18：界面上不再有"欢迎/说明"那几行 ⇒ 没有内容时**整个框藏起来**
  //   （原来是常驻一个空框，看着像出错了）。第一次写入/导出/看目录项之后它才出现。
  host.hidden = lines.length === 0;
  for (const l of lines) {
    host.appendChild(el('div', { class: l.startsWith('❌') ? 'log-bad' : l.startsWith('✅') ? 'log-ok' : 'log-line', text: l }));
  }
  host.scrollTop = host.scrollHeight;
}
