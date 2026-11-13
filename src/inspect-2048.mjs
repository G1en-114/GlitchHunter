/** Trusted, read-only test probe. Its output is not sent to the player policy. */
export async function inspect2048(page) {
  return page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('gameState') ?? 'null');
    return {
      saved,
      scoreText: document.querySelector('.score-container')?.childNodes[0]?.textContent ?? '',
      won: document.querySelector('.game-message')?.classList.contains('game-won') ?? false,
      over: document.querySelector('.game-message')?.classList.contains('game-over') ?? false
    };
  });
}

/** 公开反馈只读已渲染的 HUD；棋盘签名留在宿主，不发送格子数据给策略。 */
export async function observePublic2048(page) {
  return page.evaluate(() => {
    const board = Array.from({ length: 4 }, () => Array(4).fill(0));
    for (const tile of document.querySelectorAll('.tile')) {
      const position = tile.className.match(/tile-position-(\d+)-(\d+)/);
      const value = Number(tile.querySelector('.tile-inner')?.textContent);
      if (position && value > 0) {
        const x = Number(position[1]) - 1;
        const y = Number(position[2]) - 1;
        if (x >= 0 && x < 4 && y >= 0 && y < 4) board[y][x] = Math.max(board[y][x], value);
      }
    }
    const message = document.querySelector('.game-message');
    const screen = message?.classList.contains('game-over') ? 'lost' : message?.classList.contains('game-won') ? 'won' : 'playing';
    const score = Number.parseInt(document.querySelector('.score-container')?.childNodes[0]?.textContent ?? '0', 10);
    return { public: { score, screen }, progressKey: JSON.stringify({ board, score, screen }) };
  });
}

export function evaluate2048(capture, targetTile = 32) {
  const state = capture.verification?.state;
  const cells = state?.saved?.grid?.cells?.flat() ?? [];
  const maxTile = Math.max(0, ...cells.map(cell => cell?.value ?? 0));
  const metrics = { maxTile, score: state?.saved?.score ?? capture.observation.public?.score ?? null };
  if (maxTile >= targetTile) return { status: 'success', reason: 'target-tile-reached', metrics };
  if (state?.won || state?.saved?.won) return { status: 'failure', reason: 'win-state-without-target-tile', metrics };
  if (state?.over || state?.saved?.over) return { status: 'failure', reason: 'game-over', metrics };
  return { status: 'running', metrics };
}
