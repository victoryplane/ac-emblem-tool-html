/**
 * 【下】8 个槽位 —— **上面 = 槽号，下面 = 缩略图**（SPEC.md §四）。
 *
 * ★ 这里画的**只是当前所选作品的 8 个槽**（过滤逻辑在 `logic/slots.ts`）。
 *   切作品时 `main.ts` 会重建模型并重画，所以"换作品 ⇒ 换一套槽"。
 *
 * ★ 0.37（用户）：卡片上**除了槽号不放任何文字** —— 原来是三行（`目录\文件` / 字节数与簇号 /
 *   18 段校验状态），空槽还另有提示；用户把这整段文本圈出来要求删除，并给了版式：
 *   "**上面是槽（序号），下面红色的部分显示图片**"。⇒ 空槽现在只有一个大「＋」（`thumbNode()`）。
 *   ⚠ "本作品在卡上还没目录"这条**提醒没有丢**：它只在**真的会让人误会**时出现
 *   （`#slot-note`：8 格全空且卡上有别的作品的目录）+ 状态行 / toast（`noDirForGameText()`）。
 *   ⚠ 副本信息（字节数 / 18 段校验）仍然在别处可查：写入前自检与**落盘确认框**、以及写入日志。
 *
 * ★ 0.31（用户）：格子从"竖排"改成过"左图右文"（"红框放图片，右边白色的才是放其他所有文本的地方"），
 *   0.37 文字没了 ⇒ 图片重新变成"占满整格"，`image-rendering: pixelated`（SPEC.md 要求）不变，
 *   因为徽章只有 128×128。
 *
 * ★ 0.20：删掉槽位卡右上角那句 `icon.sys@0xDF`（8 格上重复 8 遍、用户看不懂 ⇒「直接删掉」）。
 *   事实没变：见 `logic/slots.ts` 注释与 `docs\01-项目理解\04-记忆卡与存档处理.md` §六。
 */

import { t } from './logic/i18n.ts';
import type { SlotModel } from './logic/slots.ts';
import type { GameEntry } from './logic/games.ts';
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
 * ★ 0.31 / 0.37（用户要图片"看起来更大"）：**尺寸交给 CSS** —— 原来这里写死
 *   `style.width/height = 96px`；现在图片**占满整张卡片的宽度**（`styles.css` 的 `.slot` /
 *   `.thumb-cv`：`width:100%` + `aspect-ratio:1/1`）。
 *   ⚠ 别把尺寸写回 inline style：inline 会盖掉 CSS，用户要的"更大"就没了。
 *   画布本身的 128×128 后备像素不变（`image-rendering: pixelated` 负责放大不糊）。
 */
function thumbNode(thumb: SlotThumb | null): HTMLCanvasElement | HTMLDivElement {
  if (!thumb) return el('div', { class: 'thumb-empty', text: t('＋', '+', '＋', '＋') });
  const cv = el('canvas', { class: 'thumb-cv', width: 128, height: 128 });
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(new ImageData(thumb.data, thumb.width, thumb.height), 0, 0);
  return cv;
}

/**
 * ★ 0.37（用户）：`renderSlots()` **不再收作品上下文** —— 卡片上已经没有需要按作品算出来的
 *   文字了（原来要算"这个空槽属于哪个目录 / 卡上有没有那个目录"，用来写空槽提示）。
 *   空槽提示连同整段卡片文本一起删除（见文件头）。
 */
export function renderSlots(model: SlotModel | null, cb: SlotCallbacks): void {
  const host = document.getElementById('slot-grid');
  if (!host) return;
  clear(host);

  // ★ 0.37：8 槽上方原来那行**摘要整句**已按用户要求删除（占用与空槽数、当前作品的目录名、
  //   卡上其它作品的清单，全都不再显示）。
  //   这里只剩一个**条件警告位**：本作品在卡上一个目录都没有、而卡上其实有别的作品的目录时，
  //   必须让用户看见"被隐藏了什么"（否则他会以为这张卡是空的）——这是原来那句摘要里唯一
  //   具有安全性的部分，所以它没被删掉，只是改成**只在需要时出现**。
  const note = document.getElementById('slot-note');
  if (note) {
    clear(note);
    const n = model?.excludedDirNames.length ?? 0;
    const warn = !!model && model.dirNames.length === 0 && n > 0;
    note.hidden = !warn;
    if (warn) {
      // ★ 0.43（用户："提示过于重复了"）：这条警告是"被隐藏了什么"的**主位**（就在 8 格正上方），
      //   所以它自己说全（几个别的作品的目录 + 切作品查看）；状态行/toast 那边只留一句指针。
      //   原来它写的是"卡上别的作品的徽章目录被隐藏了" —— 现在直接给出**条数**（更有信息量）。
      note.appendChild(
        el('span', {
          class: 'warn',
          text: t(
            `⚠ 这个作品在卡上还没有目录（卡上还有 ${n} 个别的作品的目录 · 切作品查看）`,
            `⚠ This game has no folder on this card yet (the card also holds folders for ${n} other games - switch game to view them)`, `⚠ この作品はまだカード上にフォルダがありません（カードには他に ${n} 作品分のフォルダがあります · 作品を切り替えて表示）`, `⚠ 이 작품은 아직 카드에 폴더가 없습니다 (카드에 다른 ${n}개 작품의 폴더가 있습니다 · 작품을 전환해 확인)`,
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
    const cls = ['slot', selected ? 'slot-selected' : '', occupied ? 'slot-occupied' : 'slot-empty']
      .filter(Boolean)
      .join(' ');

    // ★ 0.37（用户）：卡片 = **槽号在上、图在下**，没有第三样东西。
    //   版式原话："上面是槽（序号），下面红色的部分显示图片（红色部分是位置示意）"。
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
      el('span', { class: 'slot-no', text: t(`槽 ${i + 1}`, `Slot ${i + 1}`, `スロット ${i + 1}`, `슬롯 ${i + 1}`) }),
      thumbNode(thumb),
    );
    host.appendChild(card);
  }
}

/**
 * ★ 0.41（审查抓到）：**只改"哪一格被选中"的高亮**，不重建 8 格。
 *
 * 原来 `main.ts::selectSlot()` 每次点选都整批 `renderSlots()`（clear + 重建 8 张卡 + 8 次
 * `putImageData`）⇒ 被聚焦的那张卡**被删掉重建**，键盘焦点掉回 body（`tabindex` / `role=button`
 * 形同虚设：按 Tab 进去选一格，焦点就没了，没法接着用键盘选下一格），而且每次点选白重画 8 张缩略图。
 * 现在只切 class —— 卡还是那批节点，焦点与缩略图都留着。
 */
export function markSelectedSlot(index: number): void {
  for (const card of document.querySelectorAll('.slot')) {
    card.classList.toggle('slot-selected', card.getAttribute('data-slot') === String(index));
  }
}

/** 作品下拉框（只在学校验一次）。 */
export function fillGameSelect(games: readonly GameEntry[], currentId: string): void {
  const sel = document.getElementById('game-select') as HTMLSelectElement | null;
  if (!sel) return;
  clear(sel);
  for (const g of games) {
    const label = t(g.label, g.en, g.ja, g.ko) + (g.verified ? ' ✅' : t(' ⚠ 未验证', ' ⚠ unverified', ' ⚠ 未検証', ' ⚠ 미검증'));
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
      note.appendChild(el('span', { class: 'warn', text: t(entry.note, entry.noteEn, entry.noteJa, entry.noteKo) }));
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
