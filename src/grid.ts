import type { CanvasCard, GridRect } from "./types";

export function overlaps(a: GridRect, b: GridRect): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

export function gridKey(rect: GridRect): string {
  return `${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
}

function pushBeyond(
  obstacle: GridRect,
  moving: GridRect,
  direction: { x: number; y: number },
): GridRect {
  if (Math.abs(direction.x) >= Math.abs(direction.y)) {
    return direction.x >= 0
      ? { ...moving, x: obstacle.x + obstacle.w }
      : { ...moving, x: obstacle.x - moving.w };
  }

  return direction.y >= 0
    ? { ...moving, y: obstacle.y + obstacle.h }
    : { ...moving, y: obstacle.y - moving.h };
}

export function reflowCards(
  cards: CanvasCard[],
  movingId: string,
  target: GridRect,
  direction: { x: number; y: number },
): CanvasCard[] {
  const safeDirection =
    direction.x === 0 && direction.y === 0 ? { x: 0, y: 1 } : direction;
  const result = cards.map((card) =>
    card.id === movingId ? ({ ...card, ...target } as CanvasCard) : { ...card },
  );
  const queue = [movingId];
  const visitCount = new Map<string, number>();

  while (queue.length > 0) {
    const obstacleId = queue.shift()!;
    const obstacle = result.find((card) => card.id === obstacleId);
    if (!obstacle) continue;

    for (const card of result) {
      if (card.id === obstacle.id || !overlaps(obstacle, card)) continue;
      const count = (visitCount.get(card.id) ?? 0) + 1;
      visitCount.set(card.id, count);
      if (count > result.length * 3) continue;

      Object.assign(card, pushBeyond(obstacle, card, safeDirection));
      queue.push(card.id);
    }
  }

  return result;
}

export function reflowCardGroup(
  cards: CanvasCard[],
  targets: ReadonlyMap<string, GridRect>,
  direction: { x: number; y: number },
): CanvasCard[] {
  const safeDirection = direction.x === 0 && direction.y === 0 ? { x: 0, y: 1 } : direction;
  const lockedIds = new Set(targets.keys());
  const result = cards.map((card) => {
    const target = targets.get(card.id);
    return target ? ({ ...card, ...target } as CanvasCard) : { ...card };
  });
  const lockedCards = result.filter((card) => lockedIds.has(card.id));
  const queue = [...lockedCards.map((card) => card.id)];
  const visitCount = new Map<string, number>();

  const settleOutsideGroup = (card: CanvasCard): void => {
    for (let attempts = 0; attempts < lockedCards.length * 2; attempts += 1) {
      const obstacle = lockedCards.find((locked) => overlaps(locked, card));
      if (!obstacle) return;
      Object.assign(card, pushBeyond(obstacle, card, safeDirection));
    }
  };

  while (queue.length > 0) {
    const obstacleId = queue.shift()!;
    const obstacle = result.find((card) => card.id === obstacleId);
    if (!obstacle) continue;

    for (const card of result) {
      if (card.id === obstacle.id || lockedIds.has(card.id) || !overlaps(obstacle, card)) continue;
      const count = (visitCount.get(card.id) ?? 0) + 1;
      visitCount.set(card.id, count);
      if (count > result.length * 3) continue;

      Object.assign(card, pushBeyond(obstacle, card, safeDirection));
      settleOutsideGroup(card);
      queue.push(card.id);
    }
  }

  return result;
}

export function firstFreePosition(
  cards: CanvasCard[],
  origin: { x: number; y: number },
  size: { w: number; h: number },
): { x: number; y: number } {
  for (let radius = 0; radius < 100; radius += 1) {
    for (let y = origin.y - radius; y <= origin.y + radius; y += 1) {
      for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
        const candidate = { x, y, ...size };
        if (!cards.some((card) => overlaps(candidate, card))) return { x, y };
      }
    }
  }
  return origin;
}

export function clampZoom(value: number): number {
  return Math.min(2, Math.max(0.2, value));
}
