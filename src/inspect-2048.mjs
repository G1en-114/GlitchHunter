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
