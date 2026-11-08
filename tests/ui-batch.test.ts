import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiBatch } from '../src/lib/uiBatch.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('первое обновление показывается сразу, залп склеивается в одно', async () => {
  const seen: number[] = [];
  let clock = 1000;
  const batch = createUiBatch<number>((value) => seen.push(value), 120, () => clock);
  batch.push(1);
  assert.deepEqual(seen, [1], 'первый ответ виден немедленно');
  for (let i = 2; i <= 64; i++) batch.push(i);
  assert.deepEqual(seen, [1], 'залп не вызывает 63 перерисовки');
  clock += 120;
  await sleep(160);
  assert.deepEqual(seen, [1, 64], 'после такта применён самый свежий снимок');
});

test('flush применяет отложенное немедленно, cancel — забывает', async () => {
  const seen: number[] = [];
  let clock = 0;
  const batch = createUiBatch<number>((value) => seen.push(value), 1000, () => clock);
  batch.push(1);
  batch.push(2);
  batch.flush();
  assert.deepEqual(seen, [1, 2]);
  batch.flush();
  assert.deepEqual(seen, [1, 2], 'повторный flush ничего не дублирует');
  batch.push(3);
  batch.cancel();
  clock += 2000;
  await sleep(50);
  assert.deepEqual(seen, [1, 2], 'отменённое не применяется');
});

test('после паузы следующее обновление снова мгновенное', async () => {
  const seen: string[] = [];
  let clock = 0;
  const batch = createUiBatch<string>((value) => seen.push(value), 100, () => clock);
  batch.push('a');
  batch.push('b');
  clock += 100;
  await sleep(130);
  assert.deepEqual(seen, ['a', 'b']);
  // Пауза больше интервала: следующее обновление снова показывают сразу.
  clock += 150;
  batch.push('c');
  assert.deepEqual(seen, ['a', 'b', 'c']);
  batch.cancel();
});

test('нативный мост: 64 ответа отдельными задачами дают единицы перерисовок', async () => {
  // В APK каждый ответ приходит своей задачей, поэтому React не склеивает их
  // сам (в отличие от браузера). Здесь именно этот случай.
  const seen: number[] = [];
  const batch = createUiBatch<number>((value) => seen.push(value), 120);
  for (let i = 1; i <= 64; i++) {
    batch.push(i);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  batch.flush();
  assert.ok(seen.length <= 4, `перерисовок ${seen.length}, ожидалось не больше четырёх`);
  assert.equal(seen[seen.length - 1], 64, 'последний снимок обязательно применён');
  assert.equal(seen[0], 1, 'первый ответ показан сразу');
});
